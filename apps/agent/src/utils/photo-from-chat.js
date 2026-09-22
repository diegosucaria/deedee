/**
 * The wardrobe's photo tools (add_garment, analyze_outfit_photo,
 * critique_outfit, set_reference_selfie, add_to_wardrobe_trip_capsule) take
 * `image_base64`. A model cannot copy a photo's bytes into an argument, so
 * from chat none of them ever ran: the owner sent a photo, asked to add it,
 * and the tool answered "Missing image_base64".
 *
 * The photo is in the chat. This takes the latest one: from the message that
 * started the turn, or from the owner's recent messages in the same chat (he
 * often sends the photo first and the request a moment later). An argument
 * that already holds real image bytes (the web page, an API caller) is kept.
 */

const PHOTO_TOOLS = new Set([
    'add_garment', 'analyze_outfit_photo', 'critique_outfit', 'set_reference_selfie', 'add_to_wardrobe_trip_capsule',
]);

// How far back in the chat a photo still counts as "the photo he sent".
const PHOTO_MAX_AGE_MS = 30 * 60 * 1000;
// Rows to read when looking back: photos come with few messages around them.
const PHOTO_LOOKBACK_ROWS = 8;
// Below this a string is a placeholder ("attached", "<image>"), not a picture.
const MIN_PHOTO_CHARS = 200;

const NO_PHOTO_TEXT = 'No photo found in this chat. Ask the owner to send the photo here (the latest one within the last 30 minutes is used), then call the tool again without image_base64.';

/** True for a string that holds real base64 bytes, not a placeholder. */
function looksLikeBase64(value) {
    if (typeof value !== 'string') return false;
    const compact = value.replace(/\s+/g, '');
    return compact.length >= MIN_PHOTO_CHARS && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

/** `data:image/png;base64,....` split into its parts, or null. */
function fromDataUrl(value) {
    const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(value || '').trim());
    if (!m || !looksLikeBase64(m[2])) return null;
    return { mimeType: m[1].toLowerCase(), data: m[2].replace(/\s+/g, '') };
}

/** An inline image part with real bytes (a stripped row holds a marker instead). */
function isPhotoPart(part) {
    const inline = part && part.inlineData;
    return !!(inline && /^image\//i.test(String(inline.mimeType || '')) && looksLikeBase64(inline.data));
}

/** The last photo among a message's parts, or null. */
function photoInParts(parts) {
    if (!Array.isArray(parts)) return null;
    for (let i = parts.length - 1; i >= 0; i--) {
        if (isPhotoPart(parts[i])) {
            return { data: parts[i].inlineData.data.replace(/\s+/g, ''), mimeType: String(parts[i].inlineData.mimeType).toLowerCase() };
        }
    }
    return null;
}

/**
 * The arguments a photo tool should run with.
 * @param {string} toolName
 * @param {object} args - as the model gave them
 * @param {{ message?: object, db?: object, now?: number }} ctx - the turn's message and the database
 */
function photoFromChat(toolName, args, { message, db, now = Date.now() } = {}) {
    if (!PHOTO_TOOLS.has(toolName)) return args;
    const given = args && args.image_base64;

    const asDataUrl = fromDataUrl(given);
    if (asDataUrl) return { ...args, image_base64: asDataUrl.data, mime_type: args.mime_type || asDataUrl.mimeType };
    if (looksLikeBase64(given)) return args;

    // A placeholder or nothing: the photo is in the chat.
    let found = photoInParts(message && message.parts);
    const chatId = message && message.metadata && message.metadata.chatId;
    // In a group the last photo may be anyone's; only the turn's own message counts there.
    const inGroup = !!(message && message.metadata && (message.metadata.isGroup || message.metadata.groupName));
    if (!found && chatId && db && typeof db.getLastUserPhoto === 'function' && !inGroup) {
        try {
            found = db.getLastUserPhoto(chatId, { since: new Date(now - PHOTO_MAX_AGE_MS).toISOString(), rows: PHOTO_LOOKBACK_ROWS });
        } catch (err) {
            console.warn(`[Wardrobe] Could not look for a photo in the chat: ${err.message}`);
        }
    }

    const { image_base64, ...rest } = args || {};
    if (!found) return rest;
    return { ...rest, image_base64: found.data, mime_type: (args && args.mime_type) || found.mimeType };
}

module.exports = { PHOTO_TOOLS, PHOTO_MAX_AGE_MS, NO_PHOTO_TEXT, photoFromChat, photoInParts, looksLikeBase64, fromDataUrl };
