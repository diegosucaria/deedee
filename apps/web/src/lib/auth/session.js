// Signed session JWT in an httpOnly cookie. HS256 + SESSION_SECRET.
// 30-day expiry with sliding refresh on each authenticated request.
//
// Two deploy modes:
//   - Two subdomains (web.example.com + api.example.com): set
//     COOKIE_DOMAIN=.example.com so the cookie rides to api for socket.io
//     auth. Subdomains of the same eTLD+1 are same-site, so SameSite=Lax
//     is preserved.
//   - Single domain: leave COOKIE_DOMAIN unset; cookie is host-scoped.
//
// The api service verifies the same JWT on /socket.io upgrade using the
// shared SESSION_SECRET, replacing the legacy X-Forwarded-User check.
import 'server-only';
import { SignJWT, jwtVerify } from 'jose';
import { randomBytes } from 'crypto';
import { readStore, updateStore } from './store.js';

export const SESSION_COOKIE_NAME = 'deedee_session';
const ALG = 'HS256';
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

let cachedSecret = null;
let cachedSecretSource = null;

function loadSecret() {
    const envSecret = process.env.SESSION_SECRET;
    if (envSecret && envSecret.length >= 32) {
        if (cachedSecretSource !== 'env' || !cachedSecret) {
            cachedSecret = new TextEncoder().encode(envSecret);
            cachedSecretSource = 'env';
        }
        return cachedSecret;
    }

    // Fall back to a persisted secret in auth.json. This keeps the user from
    // being locked out if SESSION_SECRET is unset, but env always wins.
    const store = readStore();
    if (!store.sessionSecret) {
        const generated = randomBytes(48).toString('base64url');
        updateStore((s) => { s.sessionSecret = generated; return s; });
        cachedSecret = new TextEncoder().encode(generated);
        cachedSecretSource = 'store';
        console.warn('[auth/session] SESSION_SECRET not set — generated and persisted to auth.json. Set SESSION_SECRET in env for portability.');
        return cachedSecret;
    }
    if (cachedSecretSource !== 'store' || !cachedSecret) {
        cachedSecret = new TextEncoder().encode(store.sessionSecret);
        cachedSecretSource = 'store';
    }
    return cachedSecret;
}

function ttlSeconds() {
    const v = parseInt(process.env.SESSION_TTL_SECONDS || '', 10);
    return Number.isFinite(v) && v > 60 ? v : DEFAULT_TTL_SECONDS;
}

function isProd() {
    return process.env.NODE_ENV === 'production';
}

export function cookieAttributes() {
    const attrs = {
        name: SESSION_COOKIE_NAME,
        httpOnly: true,
        sameSite: 'lax',
        secure: isProd(),
        path: '/',
    };
    if (process.env.COOKIE_DOMAIN) attrs.domain = process.env.COOKIE_DOMAIN;
    return attrs;
}

export async function issueSession({ extra = {} } = {}) {
    const secret = loadSecret();
    const ttl = ttlSeconds();
    const jti = randomBytes(16).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ ...extra })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt(now)
        .setExpirationTime(now + ttl)
        .setJti(jti)
        .setSubject('owner')
        .sign(secret);
    return { token, ttl, jti };
}

export async function verifySession(token) {
    if (!token) return null;
    try {
        const secret = loadSecret();
        const { payload } = await jwtVerify(token, secret, { algorithms: [ALG] });
        const store = readStore();
        const revoked = (store.revokedJtis || []).some((r) => r.jti === payload.jti);
        if (revoked) return null;
        return payload;
    } catch {
        return null;
    }
}

// True if the session is older than half its TTL — refresh on the next
// authenticated request to extend the rolling expiry.
export function shouldRefresh(payload) {
    if (!payload?.iat || !payload?.exp) return false;
    const total = payload.exp - payload.iat;
    const elapsed = Math.floor(Date.now() / 1000) - payload.iat;
    return elapsed > total / 2;
}

export function revokeJti(jti, exp) {
    if (!jti) return;
    updateStore((s) => {
        s.revokedJtis = s.revokedJtis || [];
        if (!s.revokedJtis.some((r) => r.jti === jti)) {
            s.revokedJtis.push({ jti, expires: (exp || Math.floor(Date.now() / 1000) + 30 * 86400) * 1000 });
        }
        return s;
    });
}

// Build a Set-Cookie attribute object suitable for NextResponse.cookies.set
export function buildSetCookie(token, ttl) {
    return {
        ...cookieAttributes(),
        value: token,
        maxAge: ttl,
    };
}

export function buildClearCookie() {
    return {
        ...cookieAttributes(),
        value: '',
        maxAge: 0,
    };
}
