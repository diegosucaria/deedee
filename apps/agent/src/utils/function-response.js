/**
 * Builds the functionResponse parts for one tool call.
 *
 * Gemini accepts binary data on a function response as
 * `functionResponse.parts[].inlineData` (typed since @google/genai 1.34.0,
 * unchanged in 2.22.0).
 * The model payload carries the images; the DB row does not, it only notes
 * how many went out. Base64 screenshots would otherwise bloat history.
 */

/** Keeps only images the model can use: a base64 string and a mime type. */
function normalizeImages(images) {
    if (!Array.isArray(images)) return [];
    return images
        .filter(i => i && typeof i.data === 'string' && i.data.length > 0)
        .map(i => ({ mimeType: i.mimeType || 'image/png', data: i.data }));
}

/**
 * @param {{name: string}} call the model's function call
 * @param {object} apiResponse the sanitized tool result (an object map)
 * @param {Array<{mimeType: string, data: string}>} [images]
 * @returns {{ model: object, db: object }}
 */
function buildFunctionResponseParts(call, apiResponse, images) {
    const list = normalizeImages(images);
    const name = call.name;
    const db = { functionResponse: { name, response: apiResponse } };
    if (list.length === 0) {
        return { model: { functionResponse: { name, response: apiResponse } }, db };
    }
    const model = {
        functionResponse: {
            name,
            response: apiResponse,
            parts: list.map(i => ({ inlineData: { mimeType: i.mimeType, data: i.data } })),
        },
    };
    db.functionResponse.response = { ...apiResponse, _images: `${list.length} image(s) sent to model` };
    return { model, db };
}

/** Copies `parts` without `functionResponse.parts` (the inlineData). */
function stripInlineParts(parts) {
    return parts.map(p => {
        if (!p.functionResponse || !p.functionResponse.parts) return p;
        const { parts: _drop, ...rest } = p.functionResponse;
        return { functionResponse: rest };
    });
}

/**
 * One user content per image, sent on its own after the function responses.
 * Used when the model rejects `functionResponse.parts`.
 */
function imagesAsUserContent(parts, toolName = 'browser_take_screenshot') {
    const inline = [];
    for (const p of parts) {
        for (const sub of p.functionResponse?.parts || []) {
            if (sub.inlineData) inline.push({ inlineData: sub.inlineData });
        }
    }
    if (inline.length === 0) return null;
    return { role: 'user', parts: [{ text: `Screenshot from ${toolName}:` }, ...inline] };
}

/** True when a model error looks like a rejection of functionResponse.parts. */
function isPartsRejection(err) {
    const status = err?.status ?? err?.statusCode ?? err?.code;
    const msg = String(err?.message || err || '').toLowerCase();
    return (status === 400 || msg.includes('400') || msg.includes('invalid_argument')) && msg.includes('parts');
}

/** Removes `_images` from a tool result; returns { result, images }. */
function splitImages(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result) || !('_images' in result)) {
        return { result, images: [] };
    }
    const { _images, ...rest } = result;
    return { result: rest, images: normalizeImages(_images) };
}

module.exports = { buildFunctionResponseParts, stripInlineParts, imagesAsUserContent, isPartsRejection, splitImages, normalizeImages };
