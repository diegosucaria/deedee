// Turns a message's stored `parts` into rows a list can render. The history
// rows come straight from SQLite, so `parts` is a JSON string there and an
// array on the chat page; both are accepted.
//
// Image and audio bytes are replaced with a marker. A row of base64 helps
// nobody and would push the real arguments off the screen.

export const MEDIA_MARKER = '<image>';

// Argument names that hold bytes, not text.
const BLOB_KEYS = new Set(['image_base64', 'imageBase64', 'audio_base64', 'audioBase64', 'base64', 'inlineData', 'inline_data']);

/** The parts array, whatever shape it arrived in. Never throws. */
export function parseParts(raw) {
    if (Array.isArray(raw)) return raw;
    if (typeof raw !== 'string' || !raw.trim()) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * A copy of `value` with every byte blob swapped for the marker.
 * @param {*} value
 * @param {number} depth guard against a cycle or a very deep tool result
 */
// What stands in for anything nested deeper than the walk goes.
export const DEEP_MARKER = '[deep]';

export function stripBlobs(value, depth = 0) {
    // Past the guard nothing is inspected, so nothing may pass through whole.
    if (depth > 12) return DEEP_MARKER;
    if (Array.isArray(value)) return value.map(v => stripBlobs(v, depth + 1));
    if (!value || typeof value !== 'object') return value;
    // { mimeType, data } is an inline blob whatever the key above it.
    if (typeof value.data === 'string' && typeof value.mimeType === 'string') {
        return { mimeType: value.mimeType, data: MEDIA_MARKER };
    }
    const out = {};
    for (const [key, v] of Object.entries(value)) {
        out[key] = BLOB_KEYS.has(key) ? MEDIA_MARKER : stripBlobs(v, depth + 1);
    }
    return out;
}

/** Pretty JSON, with blobs already stripped. Never throws. */
export function prettyJson(value) {
    if (value === undefined || value === null) return '';
    try {
        return JSON.stringify(stripBlobs(value), null, 2);
    } catch {
        return String(value);
    }
}

/**
 * One row per part, ready to render.
 * @param {string|Array} raw the message's `parts`
 * @returns {Array<{kind: 'text'|'thought'|'call'|'result'|'media'|'other', name: string|null, body: string}>}
 */
export function describeParts(raw) {
    return parseParts(raw).map(part => {
        if (!part || typeof part !== 'object') return { kind: 'other', name: null, body: String(part ?? '') };
        if (part.functionCall) {
            return { kind: 'call', name: part.functionCall.name || 'unnamed tool', body: prettyJson(part.functionCall.args ?? {}) };
        }
        if (part.functionResponse) {
            return { kind: 'result', name: part.functionResponse.name || 'unnamed tool', body: prettyJson(part.functionResponse.response ?? {}) };
        }
        if (part.inlineData || part.inline_data) {
            const blob = part.inlineData || part.inline_data;
            return { kind: 'media', name: blob.mimeType || blob.mime_type || 'inline data', body: MEDIA_MARKER };
        }
        if (typeof part.text === 'string') {
            return { kind: part.thought ? 'thought' : 'text', name: null, body: part.text };
        }
        return { kind: 'other', name: null, body: prettyJson(part) };
    });
}

/**
 * Cut a long body down to a first screenful.
 * @returns {{ head: string, hidden: number }} hidden is 0 when nothing was cut
 */
export function clipBody(body, maxLines = 12, maxChars = 4000) {
    const text = typeof body === 'string' ? body : String(body ?? '');
    const lines = text.split('\n');
    const byLines = lines.length > maxLines;
    let head = byLines ? lines.slice(0, maxLines).join('\n') : text;
    // A tool result can be one 50,000-character line; lines alone would not cut it.
    const byChars = head.length > maxChars;
    if (byChars) head = head.slice(0, maxChars);
    return { head, hidden: (byLines ? lines.length - maxLines : 0) + (byChars ? 1 : 0) };
}
