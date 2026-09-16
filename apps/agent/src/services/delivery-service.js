/**
 * DeliveryService: the delivery ledger for outbound owner notifications.
 *
 * Every notification the agent pushes on its own (reminders, job output,
 * system alerts, askUser questions, watcher redirects, replies the
 * interface refused) goes through `deliver()`. It makes one attempt at
 * once through the existing interface.send contract, records a
 * notification_outbox row, and on failure schedules retries with backoff
 * (1 min, 5 min, 15 min, 1 h, 1 h). After the sixth failed attempt the row
 * is 'dead' and one dashboard notification is created.
 *
 * Fallback: after two failures on the primary channel (or at once when the
 * caller asks for it) the same payload goes once through the other owner
 * channel: Telegram when ALLOWED_TELEGRAM_IDS names the owner, WhatsApp when
 * owner_phone is set. Once any channel accepted the message the row is
 * 'sent'; the owner never gets the same notification twice.
 *
 * A worker tick every 60 s drains due rows. `retryNow(id)` serves the Retry
 * button in the dashboard.
 */
const crypto = require('crypto');

const BACKOFF_MS = [60e3, 300e3, 900e3, 3600e3];
const MAX_ATTEMPTS = 6;
const TICK_MS = 60e3;
const CLAIM_LIMIT = 20;
const DEDUPE_WINDOW_MS = 10 * 60e3;
const FALLBACK_AFTER_FAILURES = 2;
// A tick that hangs this long (interface never answered) no longer blocks the next one.
const TICK_STALE_MS = 10 * 60e3;
// Media travels as base64; beyond this size the row is not stored.
const MAX_CONTENT_CHARS = 2_000_000;
const DEAD_MESSAGE_CHARS = 2000;

const KINDS = ['reply', 'reminder', 'job_notification', 'system_alert', 'ask_user', 'watcher'];
const CHANNELS = ['whatsapp', 'telegram', 'web', 'slack'];

/** 'whatsapp:assistant' -> { channel: 'whatsapp', session: 'assistant' } */
function splitChannel(source) {
    const [channel, session] = String(source || '').split(':');
    return { channel, session: session || null };
}

/**
 * Build the id each channel expects. WhatsApp wants a JID, Telegram a
 * numeric chat id. Returns null when the target cannot work on that channel.
 */
function formatTarget(channel, target) {
    if (target == null) return null;
    const raw = String(target).trim();
    if (!raw) return null;
    if (channel === 'whatsapp') {
        if (raw.includes('@')) return raw;
        const digits = raw.replace(/\D/g, '');
        return digits ? `${digits}@s.whatsapp.net` : null;
    }
    if (channel === 'telegram') {
        // Telegram chat ids are numbers (groups negative). A WhatsApp JID here
        // is the old routing bug; anything else passes through untouched.
        return raw.includes('@') ? null : raw;
    }
    return raw;
}

function telegramOwnerIds() {
    return String(process.env.ALLOWED_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function ownerDigits(settings) {
    const raw = (settings && settings.owner_phone) || process.env.MY_PHONE || '';
    return String(raw).replace(/\D/g, '');
}

function contentHash(payload) {
    const h = crypto.createHash('sha1');
    h.update(`${payload.type || 'text'}\n${payload.content || ''}\n${payload.caption || ''}`);
    return h.digest('hex');
}

class DeliveryService {
    /**
     * @param {object} agent - needs db, interface, notifications, settings
     * @param {{ tickMs?: number, backoffMs?: number[], maxAttempts?: number, dedupeWindowMs?: number, fallbackAfter?: number }} [opts]
     */
    constructor(agent, opts = {}) {
        this.agent = agent;
        this.tickMs = opts.tickMs ?? TICK_MS;
        this.backoffMs = opts.backoffMs ?? BACKOFF_MS;
        this.maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
        this.dedupeWindowMs = opts.dedupeWindowMs ?? DEDUPE_WINDOW_MS;
        this.fallbackAfter = opts.fallbackAfter ?? FALLBACK_AFTER_FAILURES;
        this.timer = null;
        this._tickStartedAt = 0;
        this._inFlight = new Set();
        this._warnedNoLedger = false;
    }

    get db() { return this.agent.db; }

    /** Tests and boot paths sometimes run with a stub DB; then only the direct send happens. */
    hasLedger() {
        const db = this.db;
        const ok = !!(db && typeof db.enqueueOutbox === 'function' && typeof db.markOutboxFailed === 'function');
        if (!ok && !this._warnedNoLedger) {
            this._warnedNoLedger = true;
            console.warn('[Delivery] No outbox helpers on the DB; sending without the ledger.');
        }
        return ok;
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => {
            this.tick().catch(e => console.error('[Delivery] tick failed:', e.message));
        }, this.tickMs);
        this.timer.unref?.();
        console.log(`[Delivery] Worker started (every ${Math.round(this.tickMs / 1000)}s).`);
    }

    stop() {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
    }

    /** Fresh DB settings win; the agent's in-memory copy fills the gaps. */
    settings() {
        const memory = this.agent.settings || {};
        try {
            if (this.db && typeof this.db.getAllAgentSettings === 'function') {
                const s = this.db.getAllAgentSettings();
                if (s && typeof s === 'object') return { ...memory, ...s };
            }
        } catch (e) {
            console.warn('[Delivery] settings read failed:', e.message);
        }
        return memory;
    }

    /**
     * Where owner notifications go. Honors notification_channel and falls
     * back to the other channel when the chosen one has no id configured.
     * @returns {{ channel: string, target: string } | null}
     */
    resolveOwnerTarget(preferredChannel = null) {
        const settings = this.settings();
        const channel = splitChannel(preferredChannel || settings.notification_channel || 'whatsapp').channel;
        const digits = ownerDigits(settings);
        const tg = telegramOwnerIds()[0] || null;
        const whatsapp = digits ? { channel: 'whatsapp', target: `${digits}@s.whatsapp.net` } : null;
        const telegram = tg ? { channel: 'telegram', target: tg } : null;
        if (channel === 'telegram') {
            if (telegram) return telegram;
            if (whatsapp) console.warn('[Delivery] notification_channel is telegram but ALLOWED_TELEGRAM_IDS is empty; using WhatsApp.');
            return whatsapp;
        }
        return whatsapp || telegram;
    }

    /** True when `target` on `channel` is one of the owner's own ids. */
    isOwnerTarget(channel, target) {
        const t = formatTarget(channel, target);
        if (!t) return false;
        if (channel === 'whatsapp') {
            const digits = ownerDigits(this.settings());
            if (digits && t === `${digits}@s.whatsapp.net`) return true;
            if (digits && t === `${digits}@lid`) return true;
            const ids = this.agent._ownerWaIds;
            return !!(ids && typeof ids.has === 'function' && ids.has(t));
        }
        if (channel === 'telegram') return telegramOwnerIds().includes(t);
        return false;
    }

    /**
     * The other owner channel for a failed primary, or null. Only owner
     * notifications have a second door; a reply to a contact never
     * jumps channels.
     */
    fallbackFor(channel, target) {
        if (!this.isOwnerTarget(channel, target)) return null;
        if (channel === 'whatsapp') {
            const tg = telegramOwnerIds()[0];
            return tg ? { channel: 'telegram', target: tg } : null;
        }
        if (channel === 'telegram') {
            const digits = ownerDigits(this.settings());
            return digits ? { channel: 'whatsapp', target: `${digits}@s.whatsapp.net` } : null;
        }
        return null;
    }

    /** Accept a payload or a message-like object and keep only what a send needs. */
    normalizePayload(payload) {
        const src = payload || {};
        let content = src.content;
        let type = src.type || 'text';
        if (Array.isArray(src.parts) && src.parts.length > 0) {
            const audio = src.parts.find(p => p.inlineData?.mimeType?.startsWith('audio/'));
            const image = src.parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
            if (audio) { content = audio.inlineData.data; type = 'audio'; }
            else if (image) { content = image.inlineData.data; type = 'image'; }
        }
        if (typeof content !== 'string') content = content == null ? '' : String(content);
        const metadata = { ...(src.metadata || {}) };
        delete metadata.chatId; // the row's target owns the destination
        const out = { content, type, metadata };
        if (src.caption) out.caption = String(src.caption);
        if (src.imagePath) out.imagePath = src.imagePath;
        return out;
    }

    /** The message handed to interface.send for a row (or a row-shaped object). */
    buildMessage({ id, channel, target, payload }) {
        const p = payload || {};
        const metadata = { ...(p.metadata || {}), chatId: target };
        if (channel === 'whatsapp' && !metadata.session) metadata.session = 'assistant';
        const message = {
            id,
            role: 'assistant',
            source: channel,
            content: p.content,
            type: p.type || 'text',
            metadata,
            isNotification: true
        };
        if (p.caption) message.caption = p.caption;
        if (p.imagePath) message.imagePath = p.imagePath;
        return message;
    }

    /**
     * Send one notification: immediate attempt, ledger row, retries.
     * @param {string} kind - reply|reminder|job_notification|system_alert|ask_user|watcher
     * @param {string} channel - whatsapp|telegram|web|slack (a ':session' suffix is allowed)
     * @param {string} target - chat id / phone
     * @param {object} payload - { content, type, metadata, caption } or a message
     * @param {{ origin?: string, id?: string, expiresAt?: string, dedupe?: boolean,
     *           immediateFallback?: boolean, alreadyFailed?: boolean, error?: string }} [opts]
     * @returns {Promise<{ delivered: boolean, id?: string, status?: string, queued?: boolean, deduped?: boolean, via?: string, error?: string }>}
     */
    async deliver(kind, channel, target, payload, opts = {}) {
        if (!KINDS.includes(kind)) console.warn(`[Delivery] Unknown kind '${kind}'.`);
        const { channel: ch, session } = splitChannel(channel);
        if (!CHANNELS.includes(ch)) {
            return { delivered: false, error: `unsupported channel '${channel}'` };
        }
        const tgt = formatTarget(ch, target);
        if (!tgt) return { delivered: false, error: `bad target for ${ch}` };
        const p = this.normalizePayload(payload);
        if (ch === 'whatsapp' && session && !p.metadata.session) p.metadata.session = session;
        if (!p.content) return { delivered: false, error: 'empty content' };

        const pseudoRow = { id: opts.id || crypto.randomUUID(), kind, channel: ch, target: tgt, payload: p, origin: opts.origin || null };

        if (!this.hasLedger() || p.content.length > MAX_CONTENT_CHARS) {
            if (p.content.length > MAX_CONTENT_CHARS) console.warn(`[Delivery] ${kind} payload too large for the ledger; direct send only.`);
            if (opts.alreadyFailed) return { delivered: false, error: 'no ledger' };
            return this._directOnly(pseudoRow, opts);
        }

        const hash = contentHash(p);
        if (opts.dedupe !== false) {
            const since = new Date(Date.now() - this.dedupeWindowMs);
            const dup = this.db.findOutboxDuplicate(kind, tgt, hash, since);
            if (dup) {
                console.log(`[Delivery] Duplicate ${kind} for ${tgt} within ${Math.round(this.dedupeWindowMs / 60000)} min; not queued again (row ${dup.id}, ${dup.status}).`);
                return { delivered: dup.status === 'sent', deduped: true, id: dup.id, status: dup.status, queued: dup.status === 'pending' || dup.status === 'failed' };
            }
        }

        const preset = opts.alreadyFailed ? {
            status: 'failed',
            attempts: 1,
            lastError: String(opts.error || 'interface refused the message').slice(0, 500),
            nextAttemptAt: new Date(Date.now() + this.backoffMs[0]).toISOString()
        } : {};
        const row = this.db.enqueueOutbox({
            id: pseudoRow.id, kind, channel: ch, target: tgt, payload: p,
            origin: opts.origin || null, contentHash: hash, expiresAt: opts.expiresAt || null, ...preset
        });

        if (opts.alreadyFailed) {
            console.warn(`[Delivery] ${kind} to ${ch} queued for retry after a refused send (row ${row.id}).`);
            return { delivered: false, queued: true, id: row.id, status: row.status };
        }
        return this._attempt(row, { immediateFallback: !!opts.immediateFallback });
    }

    /** A send that already failed once (the caller made the first attempt). */
    enqueueFailed(kind, channel, target, payload, opts = {}) {
        return this.deliver(kind, channel, target, payload, { ...opts, alreadyFailed: true });
    }

    /** Without a ledger: one attempt, optional immediate fallback, nothing stored. */
    async _directOnly(row, opts) {
        const ok = await this._send(row);
        if (ok.sent) return { delivered: true, status: 'sent', via: row.channel, ledger: false };
        if (opts.immediateFallback) {
            const fb = this.fallbackFor(row.channel, row.target);
            if (fb) {
                const fbRes = await this._send({ ...row, channel: fb.channel, target: fb.target });
                if (fbRes.sent) return { delivered: true, status: 'sent', via: fb.channel, fallback: true, ledger: false };
            }
        }
        return { delivered: false, status: 'failed', error: ok.error, ledger: false };
    }

    async _send(row) {
        try {
            const result = await this.agent.interface.send(this.buildMessage(row));
            if (result === false) return { sent: false, error: 'interface refused the message' };
            return { sent: true };
        } catch (e) {
            return { sent: false, error: e.message || String(e) };
        }
    }

    /** One attempt on a stored row, then bookkeeping. */
    async _attempt(row, { immediateFallback = false } = {}) {
        if (this._inFlight.has(row.id)) {
            return { delivered: false, id: row.id, status: row.status, inFlight: true };
        }
        this._inFlight.add(row.id);
        try {
            if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
                const dead = this.db.deadLetterOutbox(row.id, 'expired before delivery');
                this._notifyDead(dead);
                return { delivered: false, id: row.id, status: 'dead', error: dead.last_error };
            }

            const res = await this._send(row);
            if (res.sent) {
                this.db.markOutboxSent(row.id, { via: row.channel });
                return { delivered: true, id: row.id, status: 'sent', via: row.channel };
            }

            let updated = this.db.markOutboxFailed(row.id, res.error, { backoffMs: this.backoffMs, maxAttempts: this.maxAttempts });
            console.warn(`[Delivery] ${row.kind} via ${row.channel} failed (attempt ${updated.attempts}/${this.maxAttempts}): ${res.error}`);

            const fallbackDue = !updated.fallback_status && (immediateFallback || updated.attempts >= this.fallbackAfter);
            if (fallbackDue) {
                const fb = this.fallbackFor(row.channel, row.target);
                if (fb) {
                    const fbRes = await this._send({ ...row, channel: fb.channel, target: fb.target });
                    updated = this.db.noteOutboxFallback(row.id, {
                        channel: fb.channel, target: fb.target,
                        status: fbRes.sent ? 'sent' : 'failed',
                        error: fbRes.sent ? null : `fallback ${fb.channel}: ${fbRes.error}`
                    });
                    if (fbRes.sent) {
                        this.db.markOutboxSent(row.id, { via: fb.channel });
                        console.log(`[Delivery] ${row.kind} delivered through the ${fb.channel} fallback (row ${row.id}).`);
                        return { delivered: true, id: row.id, status: 'sent', via: fb.channel, fallback: true };
                    }
                    console.warn(`[Delivery] ${fb.channel} fallback also failed for row ${row.id}: ${fbRes.error}`);
                }
            }

            if (updated.status === 'dead') this._notifyDead(updated);
            return {
                delivered: false, id: row.id, status: updated.status,
                queued: updated.status !== 'dead', attempts: updated.attempts, error: res.error
            };
        } finally {
            this._inFlight.delete(row.id);
        }
    }

    /** One dashboard notification per dead row. */
    _notifyDead(row) {
        const create = this.agent.notifications?.create;
        if (typeof create !== 'function') return;
        const p = row.payload || {};
        const body = p.type && p.type !== 'text'
            ? `[${p.type}] ${p.caption || ''}`.trim()
            : String(p.content || '');
        try {
            this.agent.notifications.create({
                type: 'delivery_dead',
                severity: 'error',
                title: 'Undelivered notification',
                message: body.length > DEAD_MESSAGE_CHARS ? body.slice(0, DEAD_MESSAGE_CHARS) + '...' : body,
                metadata: {
                    outboxId: row.id, kind: row.kind, channel: row.channel, attempts: row.attempts,
                    origin: row.origin || null, lastError: row.last_error || null,
                    fallback: row.fallback_status ? `${row.fallback_channel}: ${row.fallback_status}` : null,
                    link: '/system/notifications'
                }
            });
        } catch (e) {
            console.error('[Delivery] Failed to record the dead-letter notification:', e.message);
        }
        console.error(`[Delivery] ${row.kind} via ${row.channel} gave up after ${row.attempts} attempts (row ${row.id}).`);
    }

    /** Drain due rows. Called by the worker timer and by tests. */
    async tick(limit = CLAIM_LIMIT) {
        if (!this.hasLedger()) return { processed: 0 };
        const now = Date.now();
        if (this._tickStartedAt && now - this._tickStartedAt < TICK_STALE_MS) return { processed: 0, busy: true };
        this._tickStartedAt = now;
        try {
            const rows = this.db.claimDueOutbox(limit);
            let sent = 0, failed = 0;
            for (const row of rows) {
                const res = await this._attempt(row);
                if (res.delivered) sent += 1; else failed += 1;
            }
            if (rows.length > 0) console.log(`[Delivery] tick: ${rows.length} due, ${sent} sent, ${failed} still pending or dead.`);
            return { processed: rows.length, sent, failed };
        } catch (e) {
            console.error('[Delivery] tick error:', e.message);
            return { processed: 0, error: e.message };
        } finally {
            this._tickStartedAt = 0;
        }
    }

    /** Retry button: put the row back in line and try at once. */
    async retryNow(id) {
        if (!this.hasLedger()) return null;
        const row = this.db.resetOutboxRow(id);
        if (!row) return null;
        const result = await this._attempt(row);
        return { ...result, row: this.db.getOutboxRow(id) };
    }

    listRecent(limit = 50, status = null) {
        if (!this.hasLedger()) return [];
        return this.db.listRecentOutbox({ limit, status });
    }

    counts() {
        if (!this.hasLedger()) return { pending: 0, sent: 0, failed: 0, dead: 0 };
        return this.db.countOutboxByStatus();
    }
}

module.exports = {
    DeliveryService, formatTarget, splitChannel, contentHash, telegramOwnerIds, ownerDigits,
    BACKOFF_MS, MAX_ATTEMPTS, TICK_MS, DEDUPE_WINDOW_MS, FALLBACK_AFTER_FAILURES, KINDS, CHANNELS
};
