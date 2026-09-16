// Tiny in-memory rate limiter for the login routes. Single-user app so we
// only ever care about one bucket — but we key by IP anyway to avoid a
// single attacker locking the legit user out of the password path.
//
// A second, global bucket counts failed PASSWORD logins across every IP, so
// a spray from many addresses still slows down. Its cost is that a burst of
// failures also pauses password sign-in for the legit user until the window
// ends. Passkey sign-in and the session-gated password change never read or
// feed this bucket, so the owner can still get in with a passkey.
import 'server-only';

const buckets = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const GLOBAL_WINDOW_MS = 10 * 60 * 1000;
const GLOBAL_MAX_FAILURES = 50;
let globalFailures = { count: 0, reset: 0 };

// Client address for rate-limit keys. Behind a reverse proxy the proxy
// APPENDS the real client address to X-Forwarded-For, so the last entry
// is the one it added; the client can prepend anything it likes.
export function clientIp(req) {
    const fwd = req.headers.get('x-forwarded-for');
    if (fwd) {
        const parts = fwd.split(',').map((s) => s.trim()).filter(Boolean);
        if (parts.length) return parts[parts.length - 1];
    }
    return req.headers.get('x-real-ip') || 'unknown';
}

function globalWindow(now) {
    if (globalFailures.reset < now) {
        globalFailures = { count: 0, reset: now + GLOBAL_WINDOW_MS };
    }
    return globalFailures;
}

// Per-IP limit only. Use on every auth route that takes a guess from the
// client: passkey options/verify, password change, and (via
// rateLimitPasswordLogin) password login.
export function rateLimitLogin(ip) {
    const now = Date.now();
    const key = ip || 'unknown';
    const entry = buckets.get(key) || { count: 0, reset: now + WINDOW_MS };
    if (entry.reset < now) {
        entry.count = 0;
        entry.reset = now + WINDOW_MS;
    }
    entry.count += 1;
    buckets.set(key, entry);
    if (entry.count > MAX_ATTEMPTS) {
        return { allowed: false, reason: 'ip', retryAfter: Math.ceil((entry.reset - now) / 1000) };
    }
    return { allowed: true, remaining: MAX_ATTEMPTS - entry.count };
}

// Password login only: the global failure bucket first, then the per-IP
// limit. `reason: 'global'` lets the route tell the user passkeys still work.
export function rateLimitPasswordLogin(ip) {
    const now = Date.now();
    const global = globalWindow(now);
    if (global.count >= GLOBAL_MAX_FAILURES) {
        return { allowed: false, reason: 'global', retryAfter: Math.ceil((global.reset - now) / 1000) };
    }
    return rateLimitLogin(ip);
}

// Call after a failed password LOGIN only. Feeds the global bucket.
export function recordPasswordLoginFailure() {
    globalWindow(Date.now()).count += 1;
}

export function resetRateLimit(ip) {
    buckets.delete(ip || 'unknown');
}
