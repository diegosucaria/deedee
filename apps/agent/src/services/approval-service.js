/**
 * ApprovalService: a tool call the safety rules paused waits here for the
 * owner's answer, and the answer reaches the owner wherever he is.
 *
 * Flow: the tool loop calls `check()`; a deny-list hit fails the call at
 * once, a rule hit calls `request()`. `request()` stores a
 * pending_confirmations row, builds a short card and sends it through the
 * delivery ledger: to the same chat when the owner is typing there (web,
 * Telegram, his own WhatsApp chat), to the owner channel when the run came
 * from a job, a watcher, the system or another chat. The row is keyed by
 * the chat that must answer, never by a contact's chat.
 *
 * Answers: `/confirm [id]`, `/cancel [id]` and, when exactly one approval
 * waits in that chat, a plain yes/no in a strict vocabulary. Anything else
 * falls through to askUser and the model. With several pending, the reply
 * lists the ids and asks for `/confirm <id>`.
 *
 * Approved interactive calls resume through the EXECUTE_PENDING path of
 * processMessage, in the chat where they started. Approved deferred calls
 * run here, in the original run's context (source, chat id, job name), and
 * the result goes back to the owner. Rows survive restarts; a sweeper marks
 * overdue ones 'expired' (30 min for chats, 6 h for jobs by default; see
 * agent_settings `approvals`). Sub-agents cannot ask for approval; they get
 * a result telling them to report the need to the parent.
 */
const crypto = require('crypto');
const { createAssistantMessage } = require('@deedee/shared/src/types');
const { ConfirmationManager } = require('../confirmation-manager');
const { DeliveryService, telegramOwnerIds, splitChannel } = require('./delivery-service');
const { isLiveSource } = require('./ask-user');

const DEFAULTS = Object.freeze({ ttlInteractiveMin: 30, ttlDeferredHours: 6, deny: [] });
const MAX_TTL_INTERACTIVE_MIN = 24 * 60;
const MAX_TTL_DEFERRED_HOURS = 24 * 7;
const MAX_DENY_PATTERNS = 200;
const SWEEP_MS = 60e3;

// Short ids the owner can type on a phone. No i, l, o, 0, 1.
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ID_LENGTH = 6;
const MIN_PREFIX = 3;

const APPROVE_WORDS = new Set(['yes', 'y', 'si', 'sí', 'ok', 'okay', 'dale', 'approve', 'approved', 'confirm', 'confirmed', 'proceed', 'go ahead', 'adelante']);
const DENY_WORDS = new Set(['no', 'n', 'cancel', 'cancelar', 'deny', 'denied', 'nope', 'reject', 'rechazar']);

const SECRET_KEY_RE = /pass|secret|token|api[_-]?key|auth|cookie|credential|otp/i;
const SUMMARY_VALUE_CHARS = 80;
const SUMMARY_KEYS = 6;
const SUMMARY_CHARS = 320;
const RESULT_CHARS = 600;

function randomId() {
    const bytes = crypto.randomBytes(ID_LENGTH);
    let out = '';
    for (let i = 0; i < ID_LENGTH; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
    return out;
}

/** "Yes!!" -> "yes"; "  Sí. " -> "sí"; keeps inner spaces ("go ahead"). */
function normalizeWord(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[\s ]+/g, ' ')
        .replace(/^[\s"'“”‘’(¡¿]+|[\s"'“”‘’)!.,;:?…]+$/g, '')
        .trim();
}

/** 'approved' | 'denied' | null for a plain reply. */
function decisionWord(text) {
    const word = normalizeWord(text);
    if (!word) return null;
    if (APPROVE_WORDS.has(word)) return 'approved';
    if (DENY_WORDS.has(word)) return 'denied';
    return null;
}

/** Deny patterns: one per line, or ';'-separated (APPROVALS_DENY). Commas stay inside patterns. */
function splitPatterns(value) {
    if (Array.isArray(value)) return value.map(v => String(v ?? '').trim()).filter(Boolean);
    return String(value ?? '').split(/\r?\n|;/).map(s => s.trim()).filter(Boolean);
}

function envDenyPatterns() {
    return splitPatterns(process.env.APPROVALS_DENY || '');
}

/**
 * The `approvals` setting as stored: TTLs clamped, deny list as an array of
 * non-empty patterns. Shared with the settings route.
 */
function normalizeApprovalSettings(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const ttlI = Number(src.ttlInteractiveMin);
    const ttlD = Number(src.ttlDeferredHours);
    const deny = splitPatterns(src.deny).filter(p => !p.startsWith('#')).slice(0, MAX_DENY_PATTERNS);
    return {
        ttlInteractiveMin: Number.isFinite(ttlI) && ttlI >= 1 ? Math.min(Math.round(ttlI), MAX_TTL_INTERACTIVE_MIN) : DEFAULTS.ttlInteractiveMin,
        ttlDeferredHours: Number.isFinite(ttlD) && ttlD > 0 ? Math.min(Math.round(ttlD * 100) / 100, MAX_TTL_DEFERRED_HOURS) : DEFAULTS.ttlDeferredHours,
        deny
    };
}

function truncate(text, max) {
    const s = String(text ?? '');
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** "to: alice@example.com · subject: \"Hi\" · password: <redacted>" */
function summarizeArgs(args) {
    if (!args || typeof args !== 'object') return truncate(JSON.stringify(args ?? null), SUMMARY_CHARS);
    const entries = Object.entries(args);
    if (entries.length === 0) return '(no arguments)';
    const parts = entries.slice(0, SUMMARY_KEYS).map(([key, value]) => {
        if (SECRET_KEY_RE.test(key)) return `${key}: <redacted>`;
        let text;
        if (typeof value === 'string') text = value.startsWith('$') ? value : JSON.stringify(truncate(value, SUMMARY_VALUE_CHARS));
        else { try { text = truncate(JSON.stringify(value), SUMMARY_VALUE_CHARS); } catch { text = String(value); } }
        return `${key}: ${text}`;
    });
    if (entries.length > SUMMARY_KEYS) parts.push(`+${entries.length - SUMMARY_KEYS} more`);
    return truncate(parts.join(' · '), SUMMARY_CHARS);
}

function summarizeResult(result) {
    if (result === undefined || result === null) return 'no output';
    if (typeof result === 'string') return truncate(result, RESULT_CHARS);
    if (result.error) return `error: ${truncate(result.error, RESULT_CHARS)}`;
    if (result._images) return truncate(JSON.stringify({ ...result, _images: `${result._images.length} image(s)` }), RESULT_CHARS);
    try { return truncate(JSON.stringify(result), RESULT_CHARS); } catch { return truncate(String(result), RESULT_CHARS); }
}

function humanDuration(ms) {
    const min = Math.round(ms / 60e3);
    if (min < 60) return `${Math.max(1, min)} min`;
    const h = Math.round(min / 60 * 10) / 10;
    return `${h} h`;
}

/** Where the run came from, for the card. */
function describeOrigin(message) {
    const meta = message?.metadata || {};
    const source = String(message?.source || '');
    if (String(message?.content || '').startsWith('SYSTEM_WATCHER_ALERT')) {
        return `a watcher run on a ${source.split(':')[0] || 'chat'} message`;
    }
    if (meta.jobName) return `the scheduled job "${meta.jobName}"`;
    if (source === 'scheduler' || String(meta.chatId || '').startsWith('system_')) return 'a system job';
    if (source === 'subagent' || meta.isSubAgent) return 'a sub-agent';
    if (source) return `the ${source} chat`;
    return 'an internal run';
}

class ApprovalService {
    /**
     * @param {object} agent - needs db, interface, delivery, notifications, _executeTool
     * @param {{ rules?: ConfirmationManager, sweepMs?: number }} [opts]
     */
    constructor(agent, opts = {}) {
        this.agent = agent;
        this.rules = opts.rules || new ConfirmationManager(agent.db);
        this.sweepMs = opts.sweepMs ?? SWEEP_MS;
        this.timer = null;
        this._warnedNoStore = false;
    }

    get db() { return this.agent.db; }

    _delivery() {
        if (!this.agent.delivery) this.agent.delivery = new DeliveryService(this.agent);
        return this.agent.delivery;
    }

    /** Stub DBs in tests and boot paths may lack the table helpers. */
    hasStore() {
        const db = this.db;
        const ok = !!(db && typeof db.createPendingConfirmation === 'function' && typeof db.listPendingConfirmations === 'function'
            && typeof db.decidePendingConfirmation === 'function');
        if (!ok && !this._warnedNoStore) {
            this._warnedNoStore = true;
            console.warn('[Approvals] No pending_confirmations helpers on the DB; paused actions are denied.');
        }
        return ok;
    }

    // --- settings ---

    /** agent_settings `approvals`, fresh from the DB when possible, with the env deny-list appended. */
    settings() {
        let raw = this.agent.settings?.approvals;
        try {
            if (typeof this.db?.getAgentSetting === 'function') {
                const row = this.db.getAgentSetting('approvals');
                if (row && row.value !== undefined && row.value !== null) raw = row.value;
            }
        } catch (e) {
            console.warn('[Approvals] settings read failed:', e.message);
        }
        const s = normalizeApprovalSettings(raw);
        s.deny = [...new Set([...s.deny, ...envDenyPatterns()])];
        return s;
    }

    // --- guard ---

    /**
     * Deny-list first (every mode, no prompt), then the safety rules.
     * @returns {{ denied?: boolean, pattern?: string, requiresConfirmation?: boolean, message?: string, rule?: string }}
     */
    check(toolName, args) {
        const deny = this.rules.denyCheck(toolName, args, this.settings().deny);
        if (deny.denied) {
            console.warn(`[Approvals] ${toolName} blocked by deny pattern "${deny.pattern}".`);
            return {
                denied: true,
                pattern: deny.pattern,
                message: `Blocked by the owner's deny-list (pattern "${deny.pattern}"). The action did not run. Do not retry it or work around it; tell the user it is blocked.`
            };
        }
        return this.rules.check(toolName, args);
    }

    // --- routing ---

    /**
     * Who answers, and where.
     * - web, Telegram and the owner's own WhatsApp chat: that chat ('interactive')
     * - jobs, system runs, watcher runs, other chats: the owner channel ('deferred')
     * - sub-agents: no route; they report to the parent
     */
    async route(message) {
        const meta = message?.metadata || {};
        const source = String(message?.source || '');
        const chatId = meta.chatId;
        if (meta.isSubAgent || source === 'subagent') return { error: 'sub-agent' };

        const isWatcherRun = String(message?.content || '').startsWith('SYSTEM_WATCHER_ALERT');
        if (!isWatcherRun && chatId && isLiveSource(source)) {
            const channel = splitChannel(source).channel;
            if (channel !== 'whatsapp' || await this._isOwnerWaChat(chatId)) {
                return { replyChatId: String(chatId), replyChannel: source, mode: 'interactive' };
            }
        }

        const owner = this._delivery().resolveOwnerTarget();
        if (!owner) return { error: 'no owner channel configured (owner_phone or ALLOWED_TELEGRAM_IDS)' };
        return { replyChatId: owner.target, replyChannel: owner.channel, mode: 'deferred', ownerChannel: true };
    }

    async _isOwnerWaChat(chatId) {
        try {
            if (this._delivery().isOwnerTarget('whatsapp', chatId)) return true;
            if (typeof this.agent._getOwnerWaIds !== 'function') return false;
            const ids = await this.agent._getOwnerWaIds();
            const norm = this.agent._normalizeWaChatId ? this.agent._normalizeWaChatId(chatId) : chatId;
            return !!(ids && ids.has(norm));
        } catch (e) {
            console.warn('[Approvals] Owner id lookup failed:', e.message);
            return false;
        }
    }

    /** Is the owner writing from `message`'s chat (any of his ids, any channel)? */
    async _isOwnerChat(message) {
        const chatId = message?.metadata?.chatId;
        const channel = splitChannel(message?.source).channel;
        if (!chatId) return false;
        if (channel === 'web') return true;
        if (channel === 'telegram') return telegramOwnerIds().includes(String(chatId));
        if (channel === 'whatsapp') return this._isOwnerWaChat(chatId);
        return false;
    }

    // --- asking ---

    /**
     * Pause a tool call until the owner answers.
     * @returns {Promise<{ paused: boolean, id?: string, delivered?: boolean, result: object }>}
     */
    async request({ message, toolName, args, reason, sendCallback = null }) {
        const why = reason || 'This action needs the owner\'s approval.';
        if (!this.hasStore()) {
            return { paused: false, result: { error: `'${toolName}' needs the owner's approval and the approval store is unavailable. The action did not run.` } };
        }
        const route = await this.route(message);
        if (route.error === 'sub-agent') {
            return {
                paused: false,
                result: {
                    error: `'${toolName}' needs the owner's approval, and a sub-agent cannot ask for it. ` +
                        `Stop this step and report to the parent that '${toolName}' needs approval, with the arguments you intended. Do not retry.`
                }
            };
        }
        if (route.error) {
            return { paused: false, result: { error: `'${toolName}' needs the owner's approval but no channel can reach him (${route.error}). The action did not run.` } };
        }

        const settings = this.settings();
        const ttlMs = route.mode === 'interactive' ? settings.ttlInteractiveMin * 60e3 : settings.ttlDeferredHours * 3600e3;
        const meta = message?.metadata || {};
        const originMeta = {};
        for (const key of ['jobName', 'allowedTools', 'forceModel', 'session', 'phoneNumber', 'isGroup', 'groupName']) {
            if (meta[key] !== undefined) originMeta[key] = meta[key];
        }
        const row = this.db.createPendingConfirmation({
            id: this._newId(),
            originChatId: meta.chatId ? String(meta.chatId) : null,
            originSource: message?.source || null,
            originMeta,
            replyChatId: route.replyChatId,
            replyChannel: route.replyChannel,
            mode: route.mode,
            toolName,
            args: args && typeof args === 'object' ? args : {},
            summary: summarizeArgs(args),
            reason: why,
            expiresAt: new Date(Date.now() + ttlMs).toISOString()
        });

        const others = this.db.listPendingConfirmations({ replyChatId: route.replyChatId }).filter(r => r.id !== row.id);
        const outgoing = createAssistantMessage(this.buildCard(row, { others, origin: describeOrigin(message), ttlMs }));
        outgoing.source = route.replyChannel;
        outgoing.metadata = {
            chatId: route.replyChatId,
            approval: { id: row.id, status: 'pending', toolName, summary: row.summary, expiresAt: row.expires_at, mode: row.mode }
        };
        if (route.ownerChannel) {
            outgoing.metadata.session = 'assistant';
            outgoing.isNotification = true;
        }
        // Saved first so the chat shows the card after a reload; the WhatsApp
        // mirror then skips it (same id).
        try { this.db.saveMessage(outgoing); } catch (e) { console.warn('[Approvals] saveMessage failed:', e.message); }

        const outcome = await this._delivery().deliver('approval', route.replyChannel, route.replyChatId, outgoing, {
            id: outgoing.id, origin: `approval:${row.id}`, expiresAt: row.expires_at, dedupe: false,
            immediateFallback: route.mode === 'deferred'
        });
        const delivered = !!outcome.delivered;
        if (!delivered && !outcome.queued) {
            console.error(`[Approvals] Card for ${row.id} (${toolName}) could not be delivered: ${outcome.error || outcome.status}`);
        } else if (!delivered) {
            console.warn(`[Approvals] Card for ${row.id} not delivered yet; the ledger retries (outbox ${outcome.id}).`);
        }

        try {
            this.agent.notifications?.create({
                type: 'approval',
                severity: 'warning',
                title: `Approval needed: ${toolName}`,
                message: `${row.summary}\n${why}`,
                metadata: { approvalId: row.id, chatId: route.replyChatId, mode: row.mode, link: '/settings?tab=approvals' }
            });
        } catch (e) { console.warn('[Approvals] notification failed:', e.message); }
        this._broadcast({ id: row.id, status: 'pending', chatId: route.replyChatId, toolName, summary: row.summary, expiresAt: row.expires_at });

        const where = route.ownerChannel ? 'on his notification channel' : 'in this chat';
        return {
            paused: true,
            id: row.id,
            delivered,
            result: {
                info: `Action PAUSED: '${toolName}' needs the owner's approval (id ${row.id}). ${why} ` +
                    `The owner was asked ${where}${delivered ? '' : ' (delivery is being retried)'}. ` +
                    `The call runs on its own once he approves, so do not retry it, do not look for another way to do it, ` +
                    `and mention the pending approval in your reply.`
            }
        };
    }

    /** The text the owner reads. Short: what, key args, why, how to answer. */
    buildCard(row, { others = [], origin = '', ttlMs = null } = {}) {
        const lines = [
            `🛑 Approval needed (id ${row.id})`,
            `Tool: ${row.tool_name}`,
            `Args: ${row.summary || summarizeArgs(row.args)}`,
            `Why: ${row.reason || 'the safety rules paused it'}`
        ];
        if (origin) lines.push(`From: ${origin}`);
        if (others.length > 0) {
            lines.push(`Also pending here: ${others.map(o => `${o.id} (${o.tool_name})`).join(', ')}`);
            lines.push(`Reply /confirm ${row.id} or /cancel ${row.id}.`);
        } else {
            lines.push(`Reply yes or no, or /confirm ${row.id} · /cancel ${row.id}.`);
        }
        const ttl = ttlMs ?? (new Date(row.expires_at).getTime() - Date.now());
        if (Number.isFinite(ttl) && ttl > 0) lines.push(`Expires in ${humanDuration(ttl)}.`);
        return lines.join('\n');
    }

    _newId() {
        for (let i = 0; i < 8; i++) {
            const id = randomId();
            if (!this.db.getPendingConfirmation(id)) return id;
        }
        return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
    }

    // --- answering ---

    /**
     * Pending rows the writer of `message` may decide: rows keyed to this chat,
     * plus every owner-channel row when the writer is the owner (any of his ids).
     */
    async pendingFor(message) {
        if (!this.hasStore()) return [];
        const chatId = message?.metadata?.chatId;
        if (!chatId) return [];
        const all = this.db.listPendingConfirmations();
        const direct = all.filter(r => r.reply_chat_id === String(chatId));
        if (!(await this._isOwnerChat(message))) return direct;
        const seen = new Set(direct.map(r => r.id));
        const ownerRows = all.filter(r => !seen.has(r.id) && this._isOwnerRow(r));
        return [...direct, ...ownerRows];
    }

    _isOwnerRow(row) {
        if (row.mode === 'deferred') return true;
        const channel = splitChannel(row.reply_channel).channel;
        if (channel === 'web') return false;
        try { return this._delivery().isOwnerTarget(channel, row.reply_chat_id); } catch { return false; }
    }

    /** Exact id, else the one pending row whose id starts with `idArg`. */
    _match(pending, idArg) {
        const wanted = String(idArg || '').trim().toLowerCase();
        if (!wanted) return null;
        const exact = pending.find(r => r.id.toLowerCase() === wanted);
        if (exact) return exact;
        if (wanted.length < MIN_PREFIX) return null;
        const hits = pending.filter(r => r.id.toLowerCase().startsWith(wanted));
        return hits.length === 1 ? hits[0] : null;
    }

    _listText(pending, lead) {
        const items = pending.map(r => `• ${r.id} — ${r.tool_name}: ${truncate(r.summary || '', 120)}`).join('\n');
        return `${lead}\n${items}\nReply /confirm <id> or /cancel <id>.`;
    }

    /**
     * Called at the top of processMessage, before askUser. A plain yes/no
     * with exactly one approval pending in this chat decides it. Returns
     * null when the message is not an answer (it goes on to askUser and the
     * model).
     * @returns {Promise<null | { handled: boolean, reply?: object, execute?: { name: string, args: object, approvalId: string } }>}
     */
    async intercept(message, sendCallback) {
        if (!this.hasStore()) return null;
        const chatId = message?.metadata?.chatId;
        if (!chatId || message.metadata?.isSubAgent) return null;
        const text = typeof message.content === 'string' ? message.content.trim() : '';
        if (!text || text.startsWith('/')) return null;
        const decision = decisionWord(text);
        if (!decision) return null;

        const pending = await this.pendingFor(message);
        if (pending.length === 0) return null;
        try { this.db.saveMessage(message); } catch { /* history is best effort */ }
        if (pending.length > 1) {
            const lead = `${pending.length} approvals are pending here. Which one?`;
            return { handled: true, reply: await this._reply(message, this._listText(pending, lead), sendCallback) };
        }
        return this.decide(pending[0].id, decision, { via: 'chat', message, sendCallback });
    }

    /**
     * Slash commands: /confirm [id], /approve [id], /cancel [id], /deny [id], /approvals.
     * @returns {Promise<true | { type: 'EXECUTE_PENDING', action: object }>}
     */
    async handleCommand(message, cmd, idArg, sendCallback) {
        const command = String(cmd || '').toLowerCase();
        const pending = await this.pendingFor(message);
        if (command === '/approvals') {
            const text = pending.length === 0 ? 'No approvals are pending here.' : this._listText(pending, `${pending.length} pending approval(s):`);
            await this._reply(message, text, sendCallback);
            return true;
        }
        const decision = command === '/confirm' || command === '/approve' ? 'approved' : 'denied';
        let row = null;
        if (idArg) {
            row = this._match(pending, idArg);
            if (!row) {
                const text = pending.length === 0
                    ? `No pending approval matches "${idArg}".`
                    : this._listText(pending, `No pending approval matches "${idArg}". Pending here:`);
                await this._reply(message, text, sendCallback);
                return true;
            }
        } else if (pending.length === 0) {
            await this._reply(message, decision === 'approved' ? 'No pending action to confirm.' : 'No pending action to cancel.', sendCallback);
            return true;
        } else if (pending.length > 1) {
            await this._reply(message, this._listText(pending, `${pending.length} approvals are pending here. Which one?`), sendCallback);
            return true;
        } else {
            row = pending[0];
        }
        const res = await this.decide(row.id, decision, { via: 'chat', message, sendCallback });
        if (res.execute) return { type: 'EXECUTE_PENDING', action: res.execute };
        return true;
    }

    /**
     * Record the decision, then act on it. Only the first decision wins.
     * Interactive rows answered in their own chat come back as `execute`
     * for processMessage; every other approval runs here and the result is
     * delivered to the owner.
     * @param {string} id
     * @param {'approved'|'denied'} decision
     * @param {{ via?: string, message?: object|null, sendCallback?: Function|null }} [opts]
     */
    async decide(id, decision, { via = 'chat', message = null, sendCallback = null } = {}) {
        if (!this.hasStore()) return { handled: false, error: 'approval store unavailable', status: 'missing' };
        const row = this.db.decidePendingConfirmation(id, decision, { via });
        if (!row) {
            const existing = this.db.getPendingConfirmation(id);
            const why = !existing ? `No pending approval with id ${id}.` : `Approval ${id} (${existing.tool_name}) is already ${existing.status}.`;
            if (message) return { handled: true, reply: await this._reply(message, why, sendCallback), status: existing?.status || 'missing' };
            return { handled: false, error: why, status: existing?.status || 'missing' };
        }
        console.log(`[Approvals] ${row.id} (${row.tool_name}) ${decision} via ${via}.`);
        this._broadcast({ id: row.id, status: decision, chatId: row.reply_chat_id, toolName: row.tool_name });

        if (decision === 'denied') {
            const text = `Denied: ${row.tool_name} will not run.`;
            const reply = message ? await this._reply(message, text, sendCallback) : await this._deliverTo(this._resultTarget(row, null), text, row);
            return { handled: true, row, reply };
        }

        if (message && row.mode === 'interactive' && row.reply_chat_id === String(message.metadata?.chatId)) {
            return { handled: false, row, execute: { name: row.tool_name, args: row.args, approvalId: row.id } };
        }
        const outcome = await this.runApproved(row, { message });
        return { handled: true, row, result: outcome.result, reply: outcome.reply };
    }

    /**
     * Run an approved call in the original run's context and report the
     * result. Used for deferred rows and for interactive rows decided from
     * the settings card or another owner chat.
     */
    async runApproved(row, { message = null } = {}) {
        const target = this._resultTarget(row, message);
        const originMessage = {
            role: 'user',
            content: `[approved ${row.id}] ${row.tool_name}`,
            source: row.origin_source || 'system',
            metadata: { chatId: row.origin_chat_id || row.reply_chat_id, ...(row.origin_meta || {}), approvalId: row.id }
        };
        const relay = async (reply) => {
            const text = typeof reply?.content === 'string' ? reply.content : '';
            if (text) await this._deliverTo(target, text, row);
            return true;
        };
        let result;
        try {
            result = await this.agent._executeTool(row.tool_name, row.args, originMessage, relay, null, { approved: true });
        } catch (e) {
            result = { error: e.message || String(e) };
        }
        if (result === undefined || result === null) result = { info: 'No output from tool execution.' };
        try { this.db.setConfirmationResult(row.id, result); } catch (e) { console.warn('[Approvals] result store failed:', e.message); }
        const ok = !(result && typeof result === 'object' && result.error);
        const text = `${ok ? '✅ Approved and done' : '⚠️ Approved, but it failed'}: ${row.tool_name} (id ${row.id}).\nResult: ${summarizeResult(result)}`;
        const reply = await this._deliverTo(target, text, row);
        return { result, reply };
    }

    /** The chat the answer came from, else the origin chat, else the owner channel. */
    _resultTarget(row, message) {
        const chatId = message?.metadata?.chatId;
        if (chatId && message?.source) return { channel: String(message.source), chatId: String(chatId) };
        if (row.mode === 'interactive' && row.origin_chat_id && row.origin_source) {
            return { channel: row.origin_source, chatId: row.origin_chat_id };
        }
        return { channel: row.reply_channel || 'whatsapp', chatId: row.reply_chat_id };
    }

    async _deliverTo(target, text, row) {
        const outgoing = createAssistantMessage(text);
        outgoing.source = target.channel;
        outgoing.metadata = { chatId: target.chatId, approval: { id: row.id, status: row.status, toolName: row.tool_name } };
        const channel = splitChannel(target.channel).channel;
        let owner = false;
        try { owner = this._delivery().isOwnerTarget(channel, target.chatId); } catch { owner = false; }
        if (owner && channel === 'whatsapp') outgoing.metadata.session = outgoing.metadata.session || 'assistant';
        outgoing.isNotification = true;
        try { this.db.saveMessage(outgoing); } catch (e) { console.warn('[Approvals] saveMessage failed:', e.message); }
        try {
            const outcome = await this._delivery().deliver('approval', target.channel, target.chatId, outgoing, {
                id: outgoing.id, origin: `approval:${row.id}`, dedupe: false, immediateFallback: owner
            });
            if (!outcome.delivered && !outcome.queued) console.error(`[Approvals] Could not deliver the result of ${row.id}: ${outcome.error || outcome.status}`);
        } catch (e) {
            console.error('[Approvals] deliver failed:', e.message);
        }
        return outgoing;
    }

    async _reply(message, text, sendCallback) {
        const reply = createAssistantMessage(text);
        reply.metadata = { chatId: message.metadata.chatId };
        reply.source = message.source;
        try { this.db.saveMessage(reply); } catch { /* best effort */ }
        if (sendCallback) {
            try { await sendCallback(reply); } catch (e) { console.warn('[Approvals] reply failed:', e.message); }
        }
        return reply;
    }

    _broadcast(payload) {
        const b = this.agent.interface?.broadcast;
        if (typeof b !== 'function') return;
        Promise.resolve(b.call(this.agent.interface, 'agent:approval', payload)).catch(() => { });
    }

    // --- lifecycle ---

    /** Boot: expire overdue rows, keep the rest waiting. Returns the pending count. */
    loadOnBoot() {
        if (!this.hasStore()) return 0;
        this.sweep();
        const pending = this.db.listPendingConfirmations();
        if (pending.length > 0) {
            console.log(`[Approvals] ${pending.length} approval(s) still waiting from the previous run: ${pending.map(r => `${r.id} (${r.tool_name})`).join(', ')}.`);
        }
        return pending.length;
    }

    /** Mark overdue rows 'expired'. Returns them. */
    sweep() {
        if (!this.hasStore() || typeof this.db.expirePendingConfirmations !== 'function') return [];
        let rows = [];
        try { rows = this.db.expirePendingConfirmations(); } catch (e) { console.error('[Approvals] sweep failed:', e.message); return []; }
        for (const row of rows) {
            console.log(`[Approvals] ${row.id} (${row.tool_name}) expired without an answer.`);
            this._broadcast({ id: row.id, status: 'expired', chatId: row.reply_chat_id, toolName: row.tool_name });
        }
        return rows;
    }

    start() {
        if (this.timer || !this.hasStore()) return;
        this.timer = setInterval(() => { try { this.sweep(); } catch (e) { console.error('[Approvals] sweep tick failed:', e.message); } }, this.sweepMs);
        this.timer.unref?.();
    }

    stop() {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
    }

    // --- views ---

    list({ limit = 50 } = {}) {
        if (!this.hasStore()) return { pending: [], recent: [], counts: { pending: 0, approved: 0, denied: 0, expired: 0 }, settings: this.settings() };
        return {
            pending: this.db.listPendingConfirmations(),
            recent: this.db.listRecentConfirmations({ limit }),
            counts: this.db.countConfirmationsByStatus(),
            settings: this.settings()
        };
    }
}

module.exports = {
    ApprovalService, normalizeApprovalSettings, decisionWord, normalizeWord, summarizeArgs, summarizeResult,
    splitPatterns, envDenyPatterns, DEFAULTS, APPROVE_WORDS, DENY_WORDS, SWEEP_MS
};
