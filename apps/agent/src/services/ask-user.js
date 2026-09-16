/**
 * askUser: the model asks one question and waits for the next plain-text
 * message in the reply chat.
 *
 * Flow: route -> insert a pending_questions row -> send the question through
 * interface.send (never the run's send callback, which web only flushes when
 * the run ends) -> hold a promise in memory keyed by the reply chat ->
 * processMessage hands the next plain message to `intercept`, which resolves
 * the promise. A timeout, /stop, /cancel or the web Stop button ends the wait.
 */
const crypto = require('crypto');
const { createAssistantMessage } = require('@deedee/shared/src/types');
const { DeliveryService, telegramOwnerIds } = require('./delivery-service');

const DEFAULT_TIMEOUT_S = 300;
const MAX_TIMEOUT_S = 900;
const MIN_TIMEOUT_S = 5;
const MAX_OPTIONS = 8;
// A message this soon after a question expired may be its late answer.
const LATE_REPLY_WINDOW_MS = 120 * 1000;
// With no options, only a bare code (4-8 digits) reads as a late answer.
// A word such as "ok" or "hola" is a new message and must reach the model.
const LATE_CODE_RE = /^\d{4,8}$/;
const STOP_POLL_MS = 1000;

const LIVE_SOURCES = new Set(['web', 'telegram', 'whatsapp', 'whatsapp:assistant']);

/** Chats where a person reads the reply and can type back. */
function isLiveSource(source) {
    return LIVE_SOURCES.has(String(source || ''));
}

function clampTimeoutSeconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_S;
    return Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, Math.round(n)));
}

function normalizeOptions(options) {
    if (!Array.isArray(options)) return [];
    return options.map(o => String(o ?? '').trim()).filter(Boolean).slice(0, MAX_OPTIONS);
}

/** "2" answers option 2; anything else is the answer as typed. */
function mapOptionAnswer(text, options) {
    if (!options || options.length === 0) return text;
    if (/^\d{1,2}$/.test(text)) {
        const idx = Number(text) - 1;
        if (options[idx] !== undefined) return options[idx];
    }
    const hit = options.find(o => o.toLowerCase() === text.toLowerCase());
    return hit || text;
}

/**
 * True when `text` reads as an answer to a question that already closed:
 * an option number, an option's text, or (with no options) a bare code.
 * Anything else is a new request and must reach the model.
 */
function looksLikeLateAnswer(text, options) {
    if (options && options.length > 0) {
        if (/^\d{1,2}$/.test(text)) return options[Number(text) - 1] !== undefined;
        return options.some(o => o.toLowerCase() === text.toLowerCase());
    }
    return LATE_CODE_RE.test(text);
}

/** Options column (JSON text) back to an array. */
function parseOptions(raw) {
    if (Array.isArray(raw)) return raw;
    try { return JSON.parse(raw || '[]'); } catch { return []; }
}

function questionText(question, options) {
    if (!options.length) return question;
    return `${question}\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`;
}

class AskUserService {
    constructor(agent) {
        this.agent = agent;
        /** replyChatId -> { id, chatId, options, ownerChannel, finish } */
        this.waits = new Map();
        /** replyChatId -> { id, at } for questions that ended without an answer */
        this.recentlyClosed = new Map();
    }

    /** The delivery ledger: retries, backoff and the fallback channel. */
    _delivery() {
        if (!this.agent.delivery) this.agent.delivery = new DeliveryService(this.agent);
        return this.agent.delivery;
    }

    /**
     * Where the question goes and where the answer comes from.
     * - live chat (web, telegram, whatsapp assistant): the origin chat
     * - sub-agent: the parent chat, when the parent is a live chat
     * - anything else (scheduler, system, watcher, slack): the owner channel
     */
    route(message) {
        const meta = message?.metadata || {};
        const source = message?.source;

        if (meta.isSubAgent) {
            const parentChatId = meta.parentChatId;
            const parentSource = meta.parentSource
                || (parentChatId && this.agent.db.getLastUserSource ? this.agent.db.getLastUserSource(parentChatId) : null);
            if (parentChatId && isLiveSource(parentSource)) {
                return { replyChatId: parentChatId, replySource: parentSource };
            }
            return { error: 'askUser unavailable; report what you need to the parent' };
        }

        if (isLiveSource(source) && meta.chatId) {
            return { replyChatId: meta.chatId, replySource: source };
        }

        // Owner channel: notification_channel plus the id that channel needs
        // (owner_phone for WhatsApp, ALLOWED_TELEGRAM_IDS for Telegram).
        const owner = this._delivery().resolveOwnerTarget();
        if (!owner) return { error: 'askUser unavailable: no owner channel configured (owner_phone or ALLOWED_TELEGRAM_IDS)' };
        return { replyChatId: owner.target, replySource: owner.channel, ownerChannel: true };
    }

    /**
     * Tool entry point. Resolves to { answer }, { cancelled: true },
     * { timeout: true } or { error }.
     */
    async ask(message, args = {}) {
        const question = String(args.question || '').trim();
        if (!question) return { error: 'askUser needs a question' };
        const options = normalizeOptions(args.options);
        const timeoutMs = clampTimeoutSeconds(args.timeoutSeconds) * 1000;

        const route = this.route(message);
        if (route.error) return { error: route.error };
        const { replyChatId, replySource } = route;

        if (this.waits.has(replyChatId) || this.agent.db.getPendingQuestion(replyChatId)) {
            return { error: 'A question is already waiting for an answer in this chat. Wait for that answer first.' };
        }

        const id = crypto.randomUUID();
        const chatId = message.metadata?.chatId || null;
        const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
        this.agent.db.createPendingQuestion({
            id, chatId, replyChatId, replySource, source: message.source, question, options, expiresAt
        });

        const outgoing = createAssistantMessage(questionText(question, options));
        outgoing.source = replySource;
        outgoing.metadata = { chatId: replyChatId, question: { id, options } };
        if (route.ownerChannel) {
            outgoing.metadata.session = 'assistant';
            outgoing.isNotification = true;
        }
        // Saved first so the chat shows the question after a reload; the
        // WhatsApp mirror then skips it (same id).
        try { this.agent.db.saveMessage(outgoing); } catch (e) { console.warn('[AskUser] saveMessage failed:', e.message); }

        // One attempt now. A refused question is retried until it expires and
        // jumps to the other owner channel after two failures; the message id
        // doubles as the ledger row id so the thread keeps a single copy.
        const outcome = await this._delivery().deliver('ask_user', replySource, replyChatId, outgoing, {
            id: outgoing.id, origin: chatId || message.source || 'askUser', expiresAt, dedupe: false
        });
        if (!outcome.delivered && !outcome.queued) {
            this.agent.db.closePendingQuestion(id, 'failed');
            return { error: 'askUser could not deliver the question' };
        }
        if (!outcome.delivered) {
            console.warn(`[AskUser] Question ${id} not delivered yet; the ledger retries (outbox ${outcome.id}).`);
        }

        this.agent.notifications?.create({
            type: 'ask_user',
            severity: 'info',
            title: 'Deedee has a question',
            message: question,
            metadata: { chatId: replyChatId, questionId: id, link: `/chat/${encodeURIComponent(replyChatId)}` }
        });
        if (this.agent.interface.broadcast) {
            Promise.resolve(this.agent.interface.broadcast('agent:question', { id, chatId: replyChatId, question, options, expiresAt }))
                .catch(() => { });
        }

        return new Promise((resolve) => {
            const wait = { id, chatId, replyChatId, options, ownerChannel: !!route.ownerChannel };
            let timer = null;
            let poll = null;
            wait.finish = (value) => {
                clearTimeout(timer);
                clearInterval(poll);
                if (this.waits.get(replyChatId) === wait) this.waits.delete(replyChatId);
                resolve(value);
            };
            timer = setTimeout(() => {
                this.agent.db.closePendingQuestion(id, 'timeout');
                this._noteClosed(replyChatId, id, options);
                // Tell the model when the question never reached anyone.
                wait.finish(this._questionUndelivered(outgoing.id) ? { timeout: true, delivered: false } : { timeout: true });
            }, timeoutMs);
            poll = setInterval(() => {
                if (this._stopRequested(chatId, replyChatId)) this._close(wait, 'cancelled');
            }, STOP_POLL_MS);
            timer.unref?.();
            poll.unref?.();
            this.waits.set(replyChatId, wait);
        });
    }

    /**
     * Called at the top of processMessage. Returns the reply it sent when the
     * message answered (or came too late for) a question; null otherwise.
     */
    async intercept(message, sendCallback) {
        if (this.waits.size === 0 && this.recentlyClosed.size === 0) return null;
        const chatId = message?.metadata?.chatId;
        if (!chatId || message.metadata?.isSubAgent) return null;
        const text = typeof message.content === 'string' ? message.content.trim() : '';
        if (!text) return null;

        if (text.startsWith('/')) {
            if (text === '/stop' || text === '/cancel') this.cancel(chatId);
            return null;
        }

        const wait = await this._findWait(chatId, message.source);
        if (wait) {
            const answer = mapOptionAnswer(text, wait.options);
            this.agent.db.closePendingQuestion(wait.id, 'answered', answer);
            this.agent.db.saveMessage(message);
            wait.finish({ answer });
            return this._reply(message, 'Got it.', sendCallback);
        }

        // The first message after a closed question either answers it late
        // or moves on; either way the note is spent.
        const closed = this.recentlyClosed.get(chatId);
        if (closed) {
            this.recentlyClosed.delete(chatId);
            if (Date.now() - closed.at <= LATE_REPLY_WINDOW_MS && looksLikeLateAnswer(text, closed.options)) {
                this.agent.db.saveMessage(message);
                return this._reply(message, 'That question expired.', sendCallback);
            }
        }
        return null;
    }

    /** /stop or /cancel in `chatId`: end the wait that was asked there or replies there. */
    cancel(chatId) {
        for (const wait of [...this.waits.values()]) {
            if (wait.replyChatId === chatId || wait.chatId === chatId) this._close(wait, 'cancelled');
        }
    }

    cancelAll() {
        for (const wait of [...this.waits.values()]) this._close(wait, 'cancelled');
    }

    /** Boot: a wait does not survive a restart, so open rows become 'expired'. */
    expireOnBoot() {
        const rows = this.agent.db.expirePendingQuestions();
        for (const row of rows) this._noteClosed(row.reply_chat_id, row.id, parseOptions(row.options));
        if (rows.length > 0) console.log(`[AskUser] Expired ${rows.length} question(s) left from the previous run.`);
        return rows.length;
    }

    hasPending(replyChatId) {
        return this.waits.has(replyChatId);
    }

    _close(wait, status) {
        this.agent.db.closePendingQuestion(wait.id, status);
        wait.finish({ [status]: true });
    }

    _noteClosed(replyChatId, id, options = []) {
        this.recentlyClosed.set(replyChatId, { id, at: Date.now(), options: normalizeOptions(options) });
    }

    _stopRequested(chatId, replyChatId) {
        const flags = this.agent.stopFlags;
        if (flags && (flags.has('GLOBAL_STOP') || flags.has(chatId) || flags.has(replyChatId))) return true;
        return !!(chatId && this.agent.cancellationFlags?.has(chatId));
    }

    /** True when the ledger row for the question exists and never went out. */
    _questionUndelivered(messageId) {
        try {
            const row = typeof this.agent.db?.getOutboxRow === 'function' ? this.agent.db.getOutboxRow(messageId) : null;
            return !!row && row.status !== 'sent';
        } catch {
            return false;
        }
    }

    /** The wait that went to the owner channel, if any (one at a time). */
    _ownerWait() {
        for (const wait of this.waits.values()) if (wait.ownerChannel) return wait;
        return null;
    }

    async _findWait(chatId, source) {
        const direct = this.waits.get(chatId);
        if (direct) return direct;
        const channel = String(source || '').split(':')[0];
        // A question sent to the owner channel (or its fallback) may be answered
        // from the owner's Telegram while the wait is keyed to the WhatsApp JID.
        if (channel === 'telegram') {
            return telegramOwnerIds().includes(String(chatId)) ? this._ownerWait() : null;
        }
        // The owner's WhatsApp replies may arrive under a LID JID while the
        // question went to the phone JID. Match through the owner id set.
        if (channel !== 'whatsapp' || !this.agent._getOwnerWaIds) return null;
        try {
            const ids = await this.agent._getOwnerWaIds();
            const norm = this.agent._normalizeWaChatId ? this.agent._normalizeWaChatId(chatId) : chatId;
            if (!ids.has(norm)) return null;
            for (const [key, wait] of this.waits) {
                const keyNorm = this.agent._normalizeWaChatId ? this.agent._normalizeWaChatId(key) : key;
                if (ids.has(keyNorm)) return wait;
            }
            // The owner answers on WhatsApp a question that went to Telegram.
            return this._ownerWait();
        } catch (e) {
            console.warn('[AskUser] Owner id lookup failed:', e.message);
        }
        return null;
    }

    async _reply(message, text, sendCallback) {
        const reply = createAssistantMessage(text);
        reply.metadata = { chatId: message.metadata.chatId };
        reply.source = message.source;
        if (sendCallback) {
            try { await sendCallback(reply); } catch (e) { console.warn('[AskUser] ack failed:', e.message); }
        }
        return reply;
    }
}

module.exports = { AskUserService, isLiveSource, clampTimeoutSeconds, mapOptionAnswer, looksLikeLateAnswer, DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S };
