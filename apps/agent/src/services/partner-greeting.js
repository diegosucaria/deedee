/**
 * Partner greetings: a short good-morning or good-night message sent from the
 * owner's own WhatsApp account (session "user"), in the owner's own style.
 *
 * Who to greet comes from the `partner_greeting` agent setting, never from
 * source code (edited in Autopilot → Greetings):
 *   { "contact": "<phone digits, phone JID or LID JID>", "name": "<name used in notes to the owner>",
 *     "mode": "send" | "review" | "dry_run", "pausedUntil": "YYYY-MM-DD" }
 * - send: the greeting goes out, and the owner gets a WhatsApp note.
 * - review: the draft lands in Autopilot → Drafts and the owner gets it on
 *   WhatsApp; approving it there sends it. It expires after a few hours.
 * - dry_run: only the WhatsApp note; nothing reaches the partner.
 * The global communication_dry_run switch forces dry_run. The older
 * { dryRun: true } still means dry_run. pausedUntil skips both greetings
 * through that day (inclusive), for days the owner and partner are together.
 *
 * Code decides whether to send; the model only drafts the text (or declines).
 * The job skips a day when the owner already wrote to the partner, and the
 * model declines when the recent chat shows something a routine greeting
 * would ignore (an argument, bad news). Every send and every decline is
 * reported to the owner.
 */
const axios = require('axios');
const { ConfigService } = require('./config-service');

const SETTING_KEY = 'partner_greeting';
// A "day" starts at 04:00 local, so a chat that runs past midnight still
// belongs to the evening before.
const DAY_START_HOUR = 4;
const HISTORY_LIMIT = 60;

const MODES = ['send', 'review', 'dry_run'];
const DRAFT_SOURCE = 'partner_greeting';

const KINDS = {
    morning: {
        label: 'good morning',
        maxDelayMin: 75,
        // A review draft stays approvable this long.
        reviewMinutes: 180,
        guidance: 'It is the start of the day. Open the day with the owner\'s usual good-morning greeting.'
    },
    night: {
        label: 'good night',
        maxDelayMin: 45,
        reviewMinutes: 120,
        guidance: 'It is late evening. Close the day with the owner\'s usual good-night message.'
    }
};

/** Epoch ms of the current "day" start (DAY_START_HOUR local) in `timeZone`. */
function dayStartMs(now, timeZone) {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone, hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        }).formatToParts(new Date(now)).map(p => [p.type, p.value])
    );
    const wallAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    const offsetMs = wallAsUtc - Math.floor(now / 1000) * 1000;
    const dayOffset = +parts.hour < DAY_START_HOUR ? -1 : 0;
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day + dayOffset, DAY_START_HOUR) - offsetMs;
}

/** The local date (YYYY-MM-DD) a greeting at `now` belongs to; a day starts at DAY_START_HOUR. */
function greetingDay(now, timeZone) {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(new Date(dayStartMs(now, timeZone)));
}

class PartnerGreetingService {
    constructor(agent) {
        this.agent = agent;
        this.config = new ConfigService();
    }

    getSettings() {
        const row = this.agent.db.getAgentSetting?.(SETTING_KEY);
        let value = row?.value;
        if (typeof value === 'string') {
            try { value = JSON.parse(value); } catch { value = null; }
        }
        if (!value || typeof value.contact !== 'string' || !value.contact.trim()) return null;
        const mode = MODES.includes(value.mode) ? value.mode : (value.dryRun === true ? 'dry_run' : 'send');
        const pausedUntil = typeof value.pausedUntil === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.pausedUntil) ? value.pausedUntil : null;
        return { contact: value.contact.trim(), name: (value.name || 'your partner').trim(), mode, pausedUntil };
    }

    _jid(contact) {
        return contact.includes('@') ? contact : `${contact.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    }

    async fetchHistory(jid) {
        const interfacesUrl = process.env.INTERFACES_URL || 'http://interfaces:5000';
        const res = await axios.get(`${interfacesUrl}/whatsapp/history`, {
            params: { jid, limit: HISTORY_LIMIT, session: 'user' },
            headers: { Authorization: `Bearer ${process.env.DEEDEE_API_TOKEN}` }
        });
        return Array.isArray(res.data) ? res.data : [];
    }

    /** Returns a reason string when the job should not write today, else null. */
    skipReason(kind, history, now, timeZone) {
        const mine = history.filter(m => m.role === 'assistant');
        if (kind === 'morning') {
            const since = dayStartMs(now, timeZone);
            if (mine.some(m => m.timestamp >= since)) return 'the owner already wrote today';
        } else if (kind === 'night') {
            const lastMine = mine.length ? mine[mine.length - 1].timestamp : 0;
            if (now - lastMine < 60 * 60 * 1000) return 'the owner wrote within the last hour';
        }
        return null;
    }

    _formatHistory(history, timeZone) {
        const fmt = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit' });
        return history.map(m => {
            const who = m.role === 'assistant' ? 'OWNER' : 'PARTNER';
            const text = String(m.content || '').replace(/\s+/g, ' ').slice(0, 300);
            return `[${fmt.format(new Date(m.timestamp))}] ${who}: ${text}`;
        }).join('\n');
    }

    /**
     * The owner's saved notes on how they write to this person (Autopilot →
     * Style, stored on the person record), or '' when there are none.
     */
    _styleNotes(jid) {
        const person = typeof this.agent.db.getPerson === 'function' ? this.agent.db.getPerson(jid) : null;
        let meta = person?.metadata;
        if (typeof meta === 'string') {
            try { meta = JSON.parse(meta); } catch { meta = null; }
        }
        const notes = meta && typeof meta.style_profile === 'string' ? meta.style_profile.trim() : '';
        return notes.slice(0, 2000);
    }

    async draft(kind, history, now, timeZone, styleNotes = '') {
        const spec = KINDS[kind];
        const localNow = new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'full', timeStyle: 'short' }).format(new Date(now));
        const prompt = `You write one WhatsApp message that the OWNER will send to their PARTNER from the OWNER's own phone. The partner must not be able to tell it apart from the owner's own messages.

Now: ${localNow}. ${spec.guidance}

Recent chat, oldest first:
${this._formatHistory(history, timeZone)}
${styleNotes ? `
How the owner writes to this person, in the owner's own notes. Follow them; where they and the chat disagree, the notes win:
${styleNotes}
` : ''}
Rules:
- Match the OWNER's own lines above: language, spelling, capitalisation, pet names, emoji use and length. Reuse the owner's usual ${spec.label} wording if it appears. Never copy the PARTNER's style.
- One or two short lines. No quotation marks, no signature.
- If the partner already sent a ${spec.label} message today, answer it naturally instead of opening fresh.
- You may add one short line about something real and current in the chat (an exam, a trip, feeling unwell). Never invent plans, events or facts.
- Never mention an assistant, AI, automation or scheduling.
- If the latest messages show an argument, hurt, bad news or anything a routine ${spec.label} would ignore, do not write it: return send=false.

Return JSON only: {"send": true or false, "text": "the message", "reason": "one short sentence for the owner"}`;

        const model = this.config.getModel('FLASH');
        const thinking = this.config.getThinkingConfig('FLASH', 'partner_greeting', { model });
        const response = await this.agent.client.models.generateContent({
            model,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: { responseMimeType: 'application/json', temperature: 0.8, ...(thinking ? { thinkingConfig: thinking } : {}) }
        });
        this.config.logUsageFromResponse(this.agent.db, model, response, null, 'partner_greeting');

        const raw = (typeof response.text === 'function' ? response.text() : response.text)
            || response.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('')
            || '';
        const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
        return {
            send: parsed.send === true && typeof parsed.text === 'string' && parsed.text.trim().length > 0,
            text: String(parsed.text || '').trim(),
            reason: String(parsed.reason || '').trim()
        };
    }

    async _notifyOwner(text) {
        // The delivery ledger retries a refused send and falls back to the
        // other owner channel. The note goes to the owner from Deedee's own
        // number (the assistant session), never from the owner's account.
        const delivery = this.agent.delivery;
        if (delivery && typeof delivery.resolveOwnerTarget === 'function' && typeof delivery.deliver === 'function') {
            const owner = delivery.resolveOwnerTarget('whatsapp');
            if (owner) {
                const channel = owner.channel === 'whatsapp' ? 'whatsapp:assistant' : owner.channel;
                await delivery.deliver('job_notification', channel, owner.target,
                    { content: text, type: 'text' }, { origin: DRAFT_SOURCE, dedupe: false });
                return;
            }
        }
        let ownerPhone = process.env.MY_PHONE;
        const setting = this.agent.db.getAgentSetting?.('owner_phone');
        if (setting?.value) ownerPhone = setting.value;
        if (!ownerPhone) return;
        const jid = String(ownerPhone).includes('@') ? ownerPhone : `${String(ownerPhone).replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        await this.agent.interface.send({ source: 'whatsapp', type: 'text', content: text, metadata: { chatId: jid, session: 'assistant' } });
    }

    /**
     * Review mode: store the draft in Autopilot → Drafts with an expiry and
     * refresh the Drafts tab. Returns { draftId, expiresAt }.
     */
    _saveReviewDraft(kind, jid, settings, text, now) {
        const spec = KINDS[kind];
        const expiresAt = new Date(now + spec.reviewMinutes * 60 * 1000).toISOString();
        const person = typeof this.agent.db.getPerson === 'function' ? this.agent.db.getPerson(jid) : null;
        const draftId = this.agent.db.createAutopilotDraft({
            chatId: jid,
            contactId: person?.id || jid,
            content: text,
            contextContent: `Daily ${spec.label} greeting`,
            options: { kind, name: settings.name },
            source: DRAFT_SOURCE,
            expiresAt
        });
        try {
            Promise.resolve(this.agent.interface?.broadcast?.('autopilot:update', { type: 'draft_created', chatId: jid })).catch(() => {});
        } catch { /* the Drafts tab also refreshes on its own */ }
        return { draftId, expiresAt };
    }

    /**
     * @param {'morning'|'night'} kind
     * @param {{ randomDelay?: boolean, now?: () => number }} [opts]
     */
    async run(kind, opts = {}) {
        const spec = KINDS[kind];
        if (!spec) throw new Error(`Unknown greeting kind: ${kind}`);

        const settings = this.getSettings();
        if (!settings) return { skipped: true, reason: `${SETTING_KEY} setting is not configured` };

        const timeZone = process.env.TZ || 'America/Argentina/Buenos_Aires';
        const clock = opts.now || Date.now;

        // Days together: skip quietly, before waiting out the random delay.
        // The pause covers both greetings through that day; the next
        // morning's greeting runs again.
        if (settings.pausedUntil && greetingDay(clock(), timeZone) <= settings.pausedUntil) {
            console.log(`[PartnerGreeting] ${spec.label} skipped: paused through ${settings.pausedUntil}.`);
            return { skipped: true, reason: `paused through ${settings.pausedUntil}` };
        }

        if (opts.randomDelay) {
            const delayMin = Math.floor(Math.random() * (spec.maxDelayMin + 1));
            console.log(`[PartnerGreeting] ${spec.label}: waiting ${delayMin} min so it doesn't land at the same minute every day.`);
            await new Promise(r => setTimeout(r, delayMin * 60 * 1000));
        }

        const now = clock();
        const jid = this._jid(settings.contact);
        const history = await this.fetchHistory(jid);

        const skip = this.skipReason(kind, history, now, timeZone);
        if (skip) {
            console.log(`[PartnerGreeting] ${spec.label} skipped: ${skip}.`);
            return { skipped: true, reason: skip };
        }

        const draft = await this.draft(kind, history, now, timeZone, this._styleNotes(jid));
        if (!draft.send) {
            await this._notifyOwner(`I didn't send ${spec.label} to ${settings.name} today: ${draft.reason || 'the chat did not look right for it.'}`);
            return { skipped: true, reason: draft.reason || 'model declined' };
        }

        // The global switch sendMessage honours overrides the greeting's own mode.
        const globalDryRun = this.agent.db.getAgentSetting?.('communication_dry_run')?.value === true;
        const mode = globalDryRun ? 'dry_run' : settings.mode;

        if (mode === 'dry_run') {
            await this._notifyOwner(`Dry run: would have sent ${spec.label} to ${settings.name}: "${draft.text}"`);
            return { dryRun: true, kind, text: draft.text };
        }

        if (mode === 'review') {
            const { draftId, expiresAt } = this._saveReviewDraft(kind, jid, settings, draft.text, now);
            const until = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(expiresAt));
            const label = spec.label.charAt(0).toUpperCase() + spec.label.slice(1);
            await this._notifyOwner(`${label} for ${settings.name} is ready: "${draft.text}". Approve it in Autopilot → Drafts by ${until}, or it won't be sent.`);
            return { review: true, kind, text: draft.text, draftId, expiresAt };
        }

        await this.agent.interface.send({ source: 'whatsapp', type: 'text', content: draft.text, metadata: { chatId: jid, session: 'user' } });
        await this._notifyOwner(`Sent ${spec.label} to ${settings.name}: "${draft.text}"`);
        return { sent: true, kind, text: draft.text };
    }
}

module.exports = { PartnerGreetingService, dayStartMs, greetingDay, SETTING_KEY, DRAFT_SOURCE };
