/**
 * Browser gate for a tainted run: "gate submit only".
 *
 * After a run reads untrusted content, typing, logins, searching and moving
 * around a page run unasked. Actions with a consequence on money or on
 * other people ask: pay, buy, place or confirm an order, send, post,
 * publish, share, transfer, donate, delete, book, cancel a booking.
 *
 * The gate cannot see the page itself. It sees:
 * - the tool arguments (`element` is the model's own description, so it is
 *   never trusted alone; `target` is the ref from the snapshot);
 * - the last page state the browser tools returned in this run: the URL,
 *   the ARIA snapshot (inline from `browser_snapshot`, or the snapshot file
 *   an action links to), and an open dialog's message.
 *
 * `BrowserPageState` keeps that state and the element that last had focus.
 * `browserAction` decides one call. Pressing Enter (or Space on a button)
 * is judged like clicking the submit button of the form that holds focus.
 */
const fs = require('fs');
const path = require('path');

// A button or link label that commits money or reaches other people.
const CONSEQUENCE_RE = new RegExp([
    String.raw`\bpay\b`, String.raw`\bpay now\b`, String.raw`\bbuy\b`, String.raw`\bpurchase\b`,
    String.raw`\b(?:make|submit|send|process|authori[sz]e) (?:a |the |my |your )?payment\b`,
    String.raw`\bdeletion\b`, String.raw`\bsubscribe\b`, String.raw`\bupgrade\b`, String.raw`\b(?:place (?:a |my )?)?bid\b`,
    String.raw`\bcomment\b`, String.raw`\binvite\b`, String.raw`\bforward\b`,
    String.raw`\bconfirm (?:the |my )?cancell?ation\b`,
    String.raw`\bplace (?:my |your |the )?order\b`, String.raw`\border now\b`, String.raw`\bsubmit (?:my |the )?order\b`,
    String.raw`\bcomplete (?:my |the )?(?:order|purchase|checkout|payment)\b`,
    String.raw`\bconfirm (?:and pay|(?:the |my )?(?:order|purchase|payment|booking|reservation|transfer))\b`,
    String.raw`\bsend\b`, String.raw`\bpost\b`, String.raw`\bpublish\b`, String.raw`\btweet\b`, String.raw`\bshare\b`, String.raw`\breply\b`,
    String.raw`\btransfer\b`, String.raw`\bwire\b`, String.raw`\bdonate\b`, String.raw`\bdelete\b`,
    String.raw`\bbook(?: now| it)?\b`, String.raw`\breserve\b`,
    String.raw`\bcancel (?:my |the )?(?:booking|reservation|appointment|order|subscription|flight|trip)\b`,
    // Spanish
    String.raw`\bpagar\b`, String.raw`\babonar\b`, String.raw`\bcomprar\b`, String.raw`\brealizar (?:el )?pedido\b`, String.raw`\bfinalizar compra\b`,
    String.raw`\bconfirmar (?:la |el )?(?:compra|pago|pedido|reserva|turno|transferencia)\b`,
    // A bare "Enviar" is also the plain submit label of many Spanish forms: see NEUTRAL_SUBMIT_RE.
    String.raw`\benviar (?:(?:el |la |un |una |mi )?(?:mensaje|dinero|transferencia|pago|pedido|solicitud|comentario|correo|mail|email|invitaci[oó]n|respuesta))\b`,
    String.raw`\bpublicar\b`, String.raw`\bsuscribirse\b`, String.raw`\bsuscribir(?:me)?\b`, String.raw`\bcomentar\b`, String.raw`\binvitar\b`, String.raw`\breenviar\b`, String.raw`\bcompartir\b`, String.raw`\bresponder\b`,
    String.raw`\btransferir\b`, String.raw`\bdonar\b`, String.raw`\beliminar\b`, String.raw`\bborrar\b`, String.raw`\breservar\b`,
    String.raw`\bcancelar (?:la |el |mi )?(?:reserva|turno|cita|pedido|suscripci[oó]n|vuelo)\b`,
].join('|'), 'i');

// "Send code", "Resend verification link", "Enviar código": login steps, not sends.
const AUTH_SEND_RE = /\b(?:re)?(?:send|enviar|reenviar)\b.*\b(?:code|otp|sms|link|verification|c[oó]digo|enlace)\b/i;

// A generic submit label: harmless on a login form, a commit on a payment form.
const NEUTRAL_SUBMIT_RE = /^(?:submit|continue|next|ok|okay|done|confirm|accept|proceed|finish|complete|go|aceptar|confirmar|continuar|siguiente|listo|finalizar|enviar)$/i;

// Buttons that commit nothing even inside a payment form.
const HARMLESS_BUTTON_RE = /^(?:back|cancel|close|edit|show|hide|apply|apply coupon|remove|clear|help|volver|atr[aá]s|cancelar|cerrar|editar|mostrar|ocultar|aplicar|quitar|borrar campos|ayuda)$/i;

// Fields that mark a form as a payment, transfer or send form.
const PAYMENT_FIELD_RE = /card ?number|credit card|debit card|name on (?:the )?card|\bcvv\b|\bcvc\b|\bcsc\b|security code|expir|mm ?\/ ?yy|billing|\biban\b|\bswift\b|routing number|account number|\bcbu\b|\bcvu\b|\bamount\b|\bmonto\b|\bimporte\b|n[uú]mero de (?:la )?tarjeta|c[oó]digo de seguridad|vencimiento|recipient|destinatario/i;
// Fields a bank or card portal also uses as the login id. Next to a password
// field they mark a login form, not a payment form.
const LOGIN_ID_FIELD_RE = /^(?:(?:your |the )?(?:credit |debit )?card ?number|(?:your |the )?account number|n[uú]mero de (?:la )?(?:tarjeta|cuenta)|n[uú]mero de cliente)$/i;
const PASSWORD_FIELD_RE = /password|passcode|contrase[nñ]a|clave|\bpin\b/i;
// A container name that marks the same.
const PAYMENT_SCOPE_RE = /payment|checkout|\bpago\b|transfer/i;

const ENTRY_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
const SCOPE_ROLES = new Set(['form', 'search', 'dialog', 'alertdialog']);
const SEARCH_FIELD_RE = /^(?:search|buscar|b[uú]squeda)\b/i;

// Browser tools that read, wait or move around.
const READ_TOOLS = new Set([
    'browser_snapshot', 'browser_take_screenshot', 'browser_wait_for', 'browser_tabs', 'browser_console_messages',
    'browser_network_requests', 'browser_network_request', 'browser_webmcp_list', 'browser_navigate',
    'browser_navigate_back', 'browser_hover', 'browser_resize', 'browser_find', 'browser_close',
]);
// Tools that only type or pick values; nothing leaves the page on their own.
const TYPING_TOOLS = new Set(['browser_fill_form', 'browser_select_option', 'browser_drag']);

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

// A snapshot ref as @playwright/mcp prints it: e12, or f1e12 inside a frame.
const REF_RE = /^(?:f\d+)?e\d+$/;

function consequenceHit(label) {
    const s = String(label || '');
    if (!s || !CONSEQUENCE_RE.test(s)) return false;
    // A login step that "sends a code" is not a send, unless the label also pays or buys.
    if (AUTH_SEND_RE.test(s)) {
        const rest = s.replace(/\b(?:re)?(?:send|enviar|reenviar)\b/gi, '');
        return CONSEQUENCE_RE.test(rest);
    }
    return true;
}

/** The text a browser tool returned: an MCP { output }, a string, or anything else as JSON. */
function resultText(result) {
    if (result == null) return '';
    if (typeof result === 'string') return result;
    if (typeof result.output === 'string') return result.output;
    try { return JSON.stringify(result); } catch { return ''; }
}

/** Parse ARIA snapshot YAML lines into nodes: { indent, role, name, ref }. */
function parseSnapshot(yaml) {
    const nodes = [];
    for (const raw of String(yaml || '').split('\n')) {
        const m = /^(\s*)-\s+([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?([^\n]*)$/.exec(raw);
        if (!m) continue;
        const ref = /\[ref=([^\]\s]+)\]/.exec(m[4] || '');
        let name = m[3] != null ? m[3].replace(/\\"/g, '"') : '';
        // "- text: Card number" and "- button: Pay" carry the name after a colon.
        if (!name) {
            const after = /:\s*(.+)$/.exec((m[4] || '').replace(/\[[^\]]*\]/g, ''));
            if (after) name = after[1].trim().replace(/^"|"$/g, '');
        }
        nodes.push({ indent: m[1].length, role: m[2].toLowerCase(), name, ref: ref ? ref[1] : null });
    }
    return nodes;
}

class BrowserPageState {
    /**
     * @param {{ baseDir?: string|null, readFile?: (file: string) => string|null }} [opts]
     *   baseDir: the browser server's working directory, where snapshot links are
     *   relative to; or a function that returns it when a link is read.
     */
    constructor({ baseDir = null, readFile = null } = {}) {
        this.baseDir = baseDir;
        this.readFile = readFile || ((file) => {
            try {
                const stat = fs.statSync(file);
                if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return null;
                return fs.readFileSync(file, 'utf8');
            } catch { return null; }
        });
        this.url = null;
        this.nodes = [];       // the last full snapshot
        this.refs = new Map(); // ref -> node, from full and partial snapshots
        this.dialog = null;    // { message } while a dialog is open
        this.focus = null;     // { ref, element } or null when unknown
    }

    get hasPage() { return this.nodes.length > 0 || this.refs.size > 0; }

    _clearPage() {
        this.nodes = [];
        this.refs = new Map();
        this.focus = null;
    }

    _setSnapshot(yaml) {
        const nodes = parseSnapshot(yaml);
        if (nodes.length === 0) return;
        this.nodes = nodes;
        this.refs = new Map();
        for (const n of nodes) if (n.ref) this.refs.set(n.ref, n);
    }

    _snapshotFromText(text) {
        const block = /### Snapshot\s*\n```(?:yaml)?\n([\s\S]*?)```/.exec(text);
        if (block) return block[1];
        const link = /### Snapshot\s*\n-\s*\[[^\]]*\]\(([^)\s]+\.ya?ml)\)/.exec(text);
        if (!link) return null;
        const rel = link[1];
        if (!/(?:^|[\\/])page-[^\\/]*\.ya?ml$/.test(rel)) return null;
        let base = this.baseDir;
        if (typeof base === 'function') { try { base = base(); } catch { base = null; } }
        const file = path.isAbsolute(rel) ? rel : path.resolve(base || process.cwd(), rel);
        return this.readFile(file);
    }

    /**
     * Record what a browser tool returned, after it ran.
     * @param {string} toolName
     * @param {object} args
     * @param {any} result
     */
    observe(toolName, args, result) {
        const name = String(toolName || '');
        const a = args && typeof args === 'object' ? args : {};
        const text = resultText(result);
        const failed = !!(result && typeof result === 'object' && result.error);

        const url = /^- Page URL: (.+)$/m.exec(text);
        let moved = false;
        if (url && url[1].trim() !== this.url) {
            if (this.url !== null) { this._clearPage(); moved = true; }
            this.url = url[1].trim();
        }
        if (name === 'browser_navigate' || name === 'browser_navigate_back' || name === 'browser_tabs') this.focus = null;

        const modal = /dialog with message "([\s\S]*?)"\]?(?::|\n|$)/.exec(text);
        if (modal) this.dialog = { message: modal[1] };
        else if (name === 'browser_handle_dialog' || /### Page/.test(text)) this.dialog = null;

        const yaml = this._snapshotFromText(text);
        if (yaml) this._setSnapshot(yaml);
        else if (name === 'browser_find') {
            // Partial nodes: learn their refs, keep the full tree.
            for (const n of parseSnapshot(text)) if (n.ref) this.refs.set(n.ref, n);
        }

        // After a page change the old ref names another element, or none.
        if (failed || moved) return;
        switch (name) {
            case 'browser_click':
            case 'browser_type':
            case 'browser_select_option':
                this.focus = { ref: String(a.target ?? a.ref ?? ''), element: String(a.element || '') };
                break;
            case 'browser_fill_form': {
                const fields = Array.isArray(a.fields) ? a.fields : [];
                const last = fields[fields.length - 1];
                if (last) this.focus = { ref: String(last.target ?? last.ref ?? ''), element: String(last.element || last.name || '') };
                break;
            }
            case 'browser_press_key':
                // Tab and arrows move focus somewhere the gate cannot follow.
                if (/(?:^|\+)(?:Tab|Arrow\w+|PageUp|PageDown|Home|End)$/i.test(String(a.key || ''))) this.focus = null;
                break;
            default: break;
        }
    }

    node(ref) {
        return ref ? this.refs.get(String(ref)) || null : null;
    }

    _subtree(i) {
        const out = [this.nodes[i]];
        for (let j = i + 1; j < this.nodes.length && this.nodes[j].indent > this.nodes[i].indent; j++) out.push(this.nodes[j]);
        return out;
    }

    /** Indexes of the node's ancestors, nearest first. */
    _ancestors(idx) {
        const out = [];
        let indent = this.nodes[idx].indent;
        for (let i = idx - 1; i >= 0; i--) {
            if (this.nodes[i].indent < indent) { out.push(i); indent = this.nodes[i].indent; }
        }
        return out;
    }

    /**
     * The nodes that share a form with `ref`: the nearest form or dialog
     * around it; else the nearest ancestor that holds a button; else the
     * whole page. Null when the ref is not in the last full snapshot.
     */
    scopeOf(ref) {
        const idx = this.nodes.findIndex(n => n.ref === String(ref));
        if (idx < 0) return null;
        const subtree = (i) => this._subtree(i);
        const ancestors = this._ancestors(idx);
        const formIdx = ancestors.find(i => SCOPE_ROLES.has(this.nodes[i].role));
        if (formIdx !== undefined) return subtree(formIdx);
        for (const i of ancestors) {
            const nodes = subtree(i);
            if (nodes.some(n => n !== this.nodes[idx] && n.role === 'button')) return nodes;
        }
        return this.nodes;
    }

    /**
     * The form around `ref`: the nearest form or dialog, else the nearest
     * ancestor that holds an entry field, unless that is the outermost node
     * (the page itself). Null when there is none.
     */
    formOf(ref) {
        const idx = this.nodes.findIndex(n => n.ref === String(ref));
        if (idx < 0) return null;
        const subtree = (i) => this._subtree(i);
        const ancestors = this._ancestors(idx);
        const formIdx = ancestors.find(i => SCOPE_ROLES.has(this.nodes[i].role));
        if (formIdx !== undefined) return subtree(formIdx);
        for (const i of ancestors.slice(0, -1)) {
            const nodes = subtree(i);
            if (nodes.some(n => ENTRY_ROLES.has(n.role))) return nodes;
        }
        return null;
    }

    /** Does this group of nodes read as a payment, order, transfer or send form? */
    static consequential(nodes) {
        const list = nodes || [];
        return list.some(n => (n.role === 'button' && consequenceHit(n.name))
            || (SCOPE_ROLES.has(n.role) && (consequenceHit(n.name) || PAYMENT_SCOPE_RE.test(n.name))))
            || BrowserPageState.hasPaymentFields(list);
    }

    /**
     * Does this group hold a payment field? A card or account number next to
     * a password field is a bank login id, unless another payment field
     * (CVV, expiry, amount, recipient) sits there too.
     */
    static hasPaymentFields(nodes) {
        const fields = (nodes || []).filter(n => ENTRY_ROLES.has(n.role) && PAYMENT_FIELD_RE.test(n.name));
        if (fields.length === 0) return false;
        const login = (nodes || []).some(n => ENTRY_ROLES.has(n.role) && PASSWORD_FIELD_RE.test(n.name));
        if (!login) return true;
        return fields.some(n => !LOGIN_ID_FIELD_RE.test(String(n.name || '').trim()));
    }
}

/** Labels for a target: the snapshot's name for the ref, and the model's description. */
function labelsFor(state, ref, element) {
    const node = state ? state.node(ref) : null;
    return { node, labels: [node?.name, element].filter(Boolean) };
}

/** Clicking (or pressing Enter on) a button-like target. */
function judgeActivate(state, ref, element, verb) {
    const { node, labels } = labelsFor(state, ref, element);
    // Clicking into a field commits nothing, whatever the field is called.
    if (node && ENTRY_ROLES.has(node.role)) return null;
    const target = String(ref ?? '');
    // A selector such as button:has-text("Pay") names its element itself.
    if (!node && target && !REF_RE.test(target) && consequenceHit(target)) {
        return `${verb} "${target.slice(0, 80)}" on a web page (pay, buy, send, delete or book)`;
    }
    const hit = labels.find(consequenceHit);
    if (hit) return `${verb} "${hit}" on a web page (pay, buy, send, delete or book)`;
    if (!node) {
        // The target is not in the page the gate saw (a selector, or a ref
        // from a page it could not read). The model's description alone
        // cannot clear it: judge the page.
        if (!state || state.nodes.length === 0) return `${verb} an element on a web page the gate has not seen`;
        if (BrowserPageState.consequential(state.nodes)) {
            return `${verb} an element the gate cannot match on a web page that pays, orders, sends or deletes`;
        }
        return null;
    }
    const label = String(node.name || '').trim();
    const scope = state.scopeOf(ref);
    if (!scope) return null;
    if (NEUTRAL_SUBMIT_RE.test(label)) {
        if (BrowserPageState.consequential(scope)) {
            return `${verb} "${label}" in a web form that pays, orders, sends or deletes`;
        }
        return null;
    }
    // Any other button in a form that holds payment fields pays, whatever
    // its label says. A link only moves to another page.
    const form = node.role === 'link' ? null : state.formOf(ref);
    if (form && !HARMLESS_BUTTON_RE.test(label) && BrowserPageState.hasPaymentFields(form)) {
        return `${verb} "${label}" in a web form that pays`;
    }
    return null;
}

/** Enter (or Space) with focus on `focus`. */
function judgeSubmitKey(state, focus, key) {
    if (!focus || !focus.ref) {
        // Focus unknown (after Tab, or no field touched this run): judge the page.
        if (state && state.nodes.length > 0) {
            return BrowserPageState.consequential(state.nodes)
                ? `press ${key} on a web page that pays, orders, sends or deletes (focus unknown)`
                : null;
        }
        return `press ${key} on a web page the gate has not seen`;
    }
    const node = state ? state.node(focus.ref) : null;
    if (node && !ENTRY_ROLES.has(node.role)) {
        // Focus sits on a button or link: the key activates it.
        return judgeActivate(state, focus.ref, focus.element, `press ${key} on`);
    }
    if (node) {
        // Enter in a search box runs a search.
        if (node.role === 'searchbox' || SEARCH_FIELD_RE.test(node.name)) return null;
        const scope = state.scopeOf(focus.ref);
        if (scope && BrowserPageState.consequential(scope)) {
            return `press ${key} in a web form that pays, orders, sends or deletes`;
        }
        return null;
    }
    // A ref the gate never saw: judge the page it did see, then the description.
    if (state && state.nodes.length > 0 && BrowserPageState.consequential(state.nodes)) {
        return `press ${key} in a field the gate cannot match on a web page that pays, orders, sends or deletes`;
    }
    if (!REF_RE.test(focus.ref) && consequenceHit(focus.ref)) return `press ${key} in "${focus.ref.slice(0, 80)}" on a web page`;
    const desc = String(focus.element || '');
    if (consequenceHit(desc) || PAYMENT_FIELD_RE.test(desc)) return `press ${key} in "${desc}" on a web page`;
    if (/user|e-?mail|password|passcode|login|log in|sign in|search|query|buscar|b[uú]squeda|usuario|correo|contrase[nñ]a|c[oó]digo|code|otp/i.test(desc)) return null;
    return `press ${key} in a field the gate has not seen`;
}

/**
 * The consequence a browser call would have, or null when it may run in a tainted run.
 * @param {string} name
 * @param {object} args
 * @param {BrowserPageState|null} state
 * @returns {string|null}
 */
function browserAction(name, args, state = null) {
    const a = args && typeof args === 'object' ? args : {};
    if (READ_TOOLS.has(name) || TYPING_TOOLS.has(name)) return null;
    switch (name) {
        case 'browser_type':
            // Typed key by key, a newline in the text presses Enter.
            if (a.submit === true || (a.slowly === true && /[\r\n]/.test(String(a.text ?? '')))) {
                const focus = { ref: String(a.target ?? a.ref ?? ''), element: String(a.element || '') };
                return judgeSubmitKey(state, focus, 'Enter');
            }
            return null;
        case 'browser_click':
            return judgeActivate(state, a.target ?? a.ref, a.element, 'click');
        case 'browser_press_key': {
            const key = String(a.key || '');
            // Playwright splits on "+" and keeps the last part as the key:
            // "\n" and "\r" are aliases of Enter, " " is Space. Do not trim them away.
            const raw = key.split('+');
            const last = raw[raw.length - 1];
            const main = /^[\s]+$/.test(last) && last.length === 1 ? last : (last.trim() || key);
            const mods = raw.slice(0, -1).map(s => s.trim()).filter(Boolean);
            const modified = mods.some(p => /^(?:control|ctrl|meta|cmd|command|controlormeta|alt)$/i.test(p));
            const isEnter = main === '\n' || main === '\r' || /^(?:enter|numpadenter|return)$/i.test(main);
            const isSpace = main === ' ' || /^space$/i.test(main);
            // Ctrl+Enter and Cmd+Enter send in mail and chat apps.
            if (isEnter && modified) return `press ${key} on a web page (a send shortcut)`;
            if (!isEnter && !isSpace) return null;
            const focus = state ? state.focus : null;
            if (isSpace && focus && state) {
                const node = state.node(focus.ref);
                if (!node || ENTRY_ROLES.has(node.role)) return null; // a space typed into a field
            }
            return judgeSubmitKey(state, focus, isEnter ? 'Enter' : 'Space');
        }
        case 'browser_handle_dialog': {
            if (a.accept === false) return null;
            const message = state?.dialog?.message;
            if (message == null) return 'accept a web page dialog the gate has not seen';
            return consequenceHit(message) || /\b(?:charge|cargo|irreversible|permanent)/i.test(message)
                ? `accept the web page dialog "${message.slice(0, 80)}"`
                : null;
        }
        case 'browser_drop':
            return Array.isArray(a.paths) && a.paths.length > 0 ? 'upload a local file to a web page' : null;
        case 'browser_file_upload': return 'upload a local file to a web page';
        case 'browser_evaluate':
        case 'browser_run_code_unsafe': return 'run code on a web page';
        case 'browser_webmcp_call': return 'call an action the web page registered';
        default: return `run ${name} on a web page`;
    }
}

module.exports = {
    BrowserPageState, browserAction, parseSnapshot, consequenceHit,
    CONSEQUENCE_RE, NEUTRAL_SUBMIT_RE, PAYMENT_FIELD_RE,
};
