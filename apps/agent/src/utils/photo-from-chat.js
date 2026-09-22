/**
 * The wardrobe's photo tools (add_garment, analyze_outfit_photo,
 * critique_outfit, set_reference_selfie, add_to_wardrobe_trip_capsule) take
 * `image_base64`. A model cannot copy a photo's bytes into an argument, so
 * from chat none of them ever ran: the owner sent a photo, asked to add it,
 * and the tool answered "Missing image_base64".
 *
 * The photo is in the chat. This takes the latest one: from the message that
 * started the turn, or from the owner's recent messages in the same chat (he
 * often sends the photo first and the request a moment later). Only his own
 * chats count: a contact's photo, a group's or a sub-agent's is never taken,
 * or a line in a contact's message could fill his wardrobe. An argument that
 * already holds real image bytes (the web page, an API caller) is kept.
 */

const PHOTO_TOOLS = new Set([
    'add_garment', 'analyze_outfit_photo', 'critique_outfit', 'set_reference_selfie', 'add_to_wardrobe_trip_capsule',
]);

// How far back in the chat a photo still counts as "the photo he sent".
const PHOTO_MAX_AGE_MS = 30 * 60 * 1000;
// Rows to read when looking back: photos come with few messages around them.
const PHOTO_LOOKBACK_ROWS = 8;
// Below this a string is a placeholder ("attached", "<image>"), not a picture,
// unless its first bytes are an image's own signature.
const MIN_PHOTO_CHARS = 200;

const NO_PHOTO_TEXT = 'No photo found in this chat. Ask the owner to send the photo here (the latest one within the last 30 minutes is used), then call the tool again without image_base64.';

/** True when the decoded bytes start like a JPEG, PNG, GIF, WebP, BMP or HEIF file. */
function hasImageMagic(compact) {
    let head;
    try { head = Buffer.from(compact.slice(0, 24), 'base64'); } catch { return false; }
    if (head.length < 12) return false;
    const hex = head.toString('hex');
    return hex.startsWith('ffd8ff') || hex.startsWith('89504e470d0a1a0a') || hex.startsWith('474946383')
        || (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') || hex.startsWith('424d')
        || head.toString('latin1', 4, 8) === 'ftyp';
}

/** True for a string that holds real base64 image bytes, not a placeholder. */
function looksLikeBase64(value) {
    if (typeof value !== 'string') return false;
    const compact = value.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length < 16) return false;
    return compact.length >= MIN_PHOTO_CHARS || hasImageMagic(compact);
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
 * @param {{ message?: object, db?: object, now?: number, ownerChat?: boolean }} ctx - the turn's
 *   message, the database, and whether the turn is the owner's own chat (Agent._ownerTyped)
 */
function photoFromChat(toolName, args, { message, db, now = Date.now(), ownerChat = false } = {}) {
    if (!PHOTO_TOOLS.has(toolName)) return args;
    const given = args && args.image_base64;

    // Real bytes from a caller that holds them: the bytes say what they are.
    const asDataUrl = fromDataUrl(given);
    if (asDataUrl) return { ...args, image_base64: asDataUrl.data, mime_type: asDataUrl.mimeType };
    if (looksLikeBase64(given)) return args;

    const { image_base64, ...rest } = args || {};
    // Named garments need no photo. Attaching one would add clothes from a stray picture.
    if (Array.isArray(rest.garment_ids) && rest.garment_ids.length > 0) return rest;
    // Only the owner's own chat holds his photos.
    if (ownerChat !== true) return rest;

    // A placeholder or nothing: the photo is in the chat.
    let found = photoInParts(message && message.parts);
    const chatId = message && message.metadata && message.metadata.chatId;
    if (!found && chatId && db && typeof db.getLastUserPhoto === 'function') {
        try {
            found = db.getLastUserPhoto(chatId, { since: new Date(now - PHOTO_MAX_AGE_MS).toISOString(), rows: PHOTO_LOOKBACK_ROWS });
        } catch (err) {
            console.warn(`[Wardrobe] Could not look for a photo in the chat: ${err.message}`);
        }
    }

    if (!found) return rest;
    // The model never saw the bytes, so its mime_type is a guess; the part's own type wins.
    return { ...rest, image_base64: found.data, mime_type: found.mimeType };
}

module.exports = { PHOTO_TOOLS, PHOTO_MAX_AGE_MS, NO_PHOTO_TEXT, photoFromChat, photoInParts, looksLikeBase64, fromDataUrl, hasImageMagic };
