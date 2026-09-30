/**
 * Style numbers of the owner's own messages: how he writes, measured, never
 * guessed. The interfaces service computes them over his own one-to-one
 * texts and the agent keeps only the numbers (agent_settings
 * `owner_style_stats`). apps/agent/src/services/voice.js turns them into
 * rules for the model and into code clean-ups. No message text leaves this
 * function.
 */

const EMOJI_RE = /\p{Extended_Pictographic}/u;
// jaja, jajaja, jeje, jsjs, haha: laughter as people type it.
const LAUGH_RE = /(?:ja){2,}|(?:je){2,}|jsjs|(?:ha){2,}/i;
// Own messages this far apart start a new burst.
const BURST_GAP_MS = 90e3;
const MAX_TEXT_CHARS = 600;

function round(value) {
    return Math.round(value * 1000) / 1000;
}

/** A text that says something about how he types: not a media label or a bare link. */
function usableText(text) {
    const t = String(text ?? '').trim();
    if (!t || t.length >= MAX_TEXT_CHARS) return null;
    if (/^\[[^\]]*\]$/.test(t) || /^\[(?:Audio|Image|Sticker|Media|Video|Document)/i.test(t)) return null;
    if (/^https?:\/\/\S+$/i.test(t)) return null;
    return t;
}

/**
 * @param {Array<string | { text: string, ts?: number, chat?: string }>} messages
 *   the owner's own messages; `ts` (ms) and `chat` let it count bursts
 * @returns {{ n: number, questions?: number, openQuestion?: number, openExclamation?: number,
 *   exclamation?: number, endsWithPeriod?: number, startsLower?: number, comma?: number,
 *   emoji?: number, laugh?: number, multiline?: number, medianLength?: number,
 *   p90Length?: number, perBurst?: number }}
 *   Shares are 0..1. openQuestion is over questions only.
 */
function styleStats(messages) {
    const items = [];
    for (const m of Array.isArray(messages) ? messages : []) {
        const raw = typeof m === 'string' ? m : m?.text;
        const text = usableText(raw);
        if (!text) continue;
        items.push({ text, ts: Number(m?.ts) || null, chat: m?.chat ? String(m.chat) : null });
    }
    const n = items.length;
    if (n === 0) return { n: 0 };
    const texts = items.map(i => i.text);
    const share = (test) => round(texts.filter(test).length / n);
    const questions = texts.filter(t => t.includes('?'));
    const lengths = texts.map(t => t.length).sort((a, b) => a - b);
    const at = (q) => lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * q))];
    const stats = {
        n,
        questions: questions.length,
        openQuestion: questions.length ? round(questions.filter(t => t.includes('¿')).length / questions.length) : 0,
        openExclamation: share(t => t.includes('¡')),
        exclamation: share(t => t.includes('!')),
        endsWithPeriod: share(t => /[^.]\.$/.test(t)),
        startsLower: share(t => /^[a-záéíóúñü]/.test(t)),
        comma: share(t => t.includes(',')),
        emoji: share(t => EMOJI_RE.test(t)),
        laugh: share(t => LAUGH_RE.test(t)),
        multiline: share(t => t.includes('\n')),
        medianLength: at(0.5),
        p90Length: at(0.9)
    };
    // Bursts: runs of his own messages in one chat, each within BURST_GAP_MS of the last.
    const timed = items.filter(i => i.ts && i.chat);
    if (timed.length >= 10) {
        const byChat = new Map();
        for (const i of timed) {
            if (!byChat.has(i.chat)) byChat.set(i.chat, []);
            byChat.get(i.chat).push(i.ts);
        }
        let bursts = 0;
        for (const list of byChat.values()) {
            list.sort((a, b) => a - b);
            list.forEach((ts, idx) => { if (idx === 0 || ts - list[idx - 1] > BURST_GAP_MS) bursts++; });
        }
        stats.perBurst = round(timed.length / Math.max(1, bursts));
    }
    return stats;
}

module.exports = { styleStats, usableText, BURST_GAP_MS };
