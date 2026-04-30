// Tiny in-memory rate limiter for /api/auth/login. Single-user app so
// we only ever care about one bucket — but we key by IP anyway to avoid
// a single attacker locking the legit user out of the password path.
import 'server-only';

const buckets = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

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
        return { allowed: false, retryAfter: Math.ceil((entry.reset - now) / 1000) };
    }
    return { allowed: true, remaining: MAX_ATTEMPTS - entry.count };
}

export function resetRateLimit(ip) {
    buckets.delete(ip || 'unknown');
}
