// Passkey ceremonies require a Secure Context (HTTPS or localhost).
// Disable the routes & UI when the configured origin is plain http and
// not localhost — the browser would refuse anyway, this just gives a
// clearer error and avoids leaking server-side state.
import 'server-only';

export function passkeyOrigin() {
    return process.env.WEBAUTHN_ORIGIN || process.env.WEB_ORIGIN || '';
}

export function passkeyRpId() {
    return process.env.WEBAUTHN_RP_ID || '';
}

export function passkeysEnabled() {
    const origin = passkeyOrigin();
    if (!origin || !passkeyRpId()) return false;
    try {
        const url = new URL(origin);
        if (url.protocol === 'https:') return true;
        // Allow plain http only on localhost / 127.0.0.1 for dev.
        if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return true;
        return false;
    } catch {
        return false;
    }
}
