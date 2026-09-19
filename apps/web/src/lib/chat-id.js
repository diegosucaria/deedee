// The chat id from the /chat/[id] route segment.
//
// Next 14 hands a dynamic segment to the page still percent-encoded, so a
// WhatsApp id arrives as "10000000000%40s.whatsapp.net". Every caller encodes
// the id again on its way to the API, so it is decoded once here, or the chat
// is looked up under the wrong id and shows no history. An id that cannot be
// decoded is used as it came.

/** @param {string} param */
export function chatIdFromParam(param) {
    const raw = String(param ?? '');
    try { return decodeURIComponent(raw); } catch { return raw; }
}
