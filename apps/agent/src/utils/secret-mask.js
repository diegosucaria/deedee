/**
 * Masking for settings that hold credentials.
 *
 * GET /internal/settings used to return provider keys and OAuth tokens in
 * clear, and the api proxies that route to any bearer holder. Reads now carry
 * a marker in place of every secret-looking value: the name stays, the value
 * does not. Writes send the marker back for fields they did not change, and
 * the stored value is kept.
 *
 *   read:  { apiKey: { __secret: true, set: true }, models: ['grok-4'] }
 *   write: { apiKey: { __secret: true }, models: ['grok-4', 'grok-5'] }
 *          -> stored apiKey unchanged
 *   write: { apiKey: '' }      -> stored apiKey cleared
 *   write: { apiKey: 'xai-…' } -> stored apiKey replaced
 */

// Field and setting names whose value is a credential.
const SECRET_NAME = /(pass|pwd|token|secret|key|credential|cookie|auth|private|webhook)/i;

// Names that match the rule above but hold no credential.
const NOT_SECRET = /^(keywords?|keyboard|monkey|passenger|passengers)$/i;

/** True when a value under this name must never be served. */
function isSecretName(name) {
    if (typeof name !== 'string' || !name) return false;
    if (NOT_SECRET.test(name)) return false;
    return SECRET_NAME.test(name);
}

/** True for the marker this module puts in place of a secret. */
function isSecretMarker(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value) && value.__secret === true;
}

function marker(set) {
    return { __secret: true, set: !!set };
}

/**
 * Copy of `value` with every secret-looking string replaced by a marker.
 * `name` is the key the value sits under (the setting key at the top level).
 */
function maskSecrets(value, name = '') {
    if (typeof value === 'string') {
        return isSecretName(name) ? marker(value.length > 0) : value;
    }
    if (Array.isArray(value)) return value.map((item) => maskSecrets(item, name));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = maskSecrets(v, k);
        return out;
    }
    // A secret-named field holding null/undefined counts as unset.
    if (isSecretName(name) && (value === null || value === undefined)) return marker(false);
    return value;
}

/** Every setting in a { key: value } map, masked. */
function maskSettings(settings) {
    const out = {};
    for (const [key, value] of Object.entries(settings || {})) out[key] = maskSecrets(value, key);
    return out;
}

/**
 * Value to store: `incoming` with every marker replaced by what is already
 * stored. A marker with nothing stored disappears, so a save never writes the
 * marker itself into the database.
 */
function unmaskSecrets(incoming, stored) {
    if (isSecretMarker(incoming)) return stored;
    if (Array.isArray(incoming)) return incoming.map((item, i) => unmaskSecrets(item, Array.isArray(stored) ? stored[i] : undefined));
    if (incoming && typeof incoming === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(incoming)) {
            const kept = unmaskSecrets(v, stored && typeof stored === 'object' ? stored[k] : undefined);
            if (kept === undefined) continue;
            out[k] = kept;
        }
        return out;
    }
    return incoming;
}

/** True when `value` holds at least one marker, at any depth. */
function hasSecretMarker(value) {
    if (isSecretMarker(value)) return true;
    if (Array.isArray(value)) return value.some(hasSecretMarker);
    if (value && typeof value === 'object') return Object.values(value).some(hasSecretMarker);
    return false;
}

module.exports = { isSecretName, isSecretMarker, hasSecretMarker, maskSecrets, maskSettings, unmaskSecrets, SECRET_NAME };
