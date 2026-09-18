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
// A passkey is the strong sign-in: the device holds the key and asks for a
// face or a fingerprint, so its session may live longer than a password's.
const DEFAULT_PASSKEY_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

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

// "2592000", "30d", "12h", "45m". A value that is not one of those, or is
// under five minutes, is ignored: "90d" must not become 90 seconds.
const MIN_TTL_SECONDS = 300;
const UNITS = { s: 1, m: 60, h: 3600, d: 86400 };
export function parseTtl(value) {
    const m = /^\s*(\d+)\s*([smhd])?\s*$/i.exec(String(value ?? ''));
    if (!m) return null;
    const seconds = parseInt(m[1], 10) * (UNITS[(m[2] || 's').toLowerCase()]);
    return Number.isFinite(seconds) && seconds >= MIN_TTL_SECONDS ? seconds : null;
}

function envSeconds(name) {
    return parseTtl(process.env[name]);
}

/**
 * How long a session lives, by how the owner signed in.
 * SESSION_TTL_PASSKEY_SECONDS covers passkeys, SESSION_TTL_SECONDS the rest.
 * @param {string|null} method - 'passkey', 'password', 'google'
 */
function ttlSeconds(method = null) {
    if (String(method || '') === 'passkey') {
        return envSeconds('SESSION_TTL_PASSKEY_SECONDS') || envSeconds('SESSION_TTL_SECONDS') || DEFAULT_PASSKEY_TTL_SECONDS;
    }
    return envSeconds('SESSION_TTL_SECONDS') || DEFAULT_TTL_SECONDS;
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
    const ttl = ttlSeconds(extra.method);
    const jti = randomBytes(16).toString('base64url');
    // The session id outlives every refresh, so signing out ends the whole
    // chain. The jti changes on each slide and cannot carry revocation.
    const sid = extra.sid || randomBytes(16).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ ...extra, sid })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt(now)
        .setExpirationTime(now + ttl)
        .setJti(jti)
        .setSubject('owner')
        .sign(secret);
    return { token, ttl, jti, sid };
}

export async function verifySession(token) {
    if (!token) return null;
    try {
        const secret = loadSecret();
        const { payload } = await jwtVerify(token, secret, { algorithms: [ALG] });
        const store = readStore();
        if ((store.revokedJtis || []).some((r) => r.jti === payload.jti)) {
            keepRevocationAlive('revokedJtis', 'jti', payload.jti, payload.exp);
            return null;
        }
        // A signed-out session: every token in its chain is dead, however new.
        if (payload.sid && (store.revokedSids || []).some((r) => r.sid === payload.sid)) {
            // The edge keeps sliding a cookie it cannot check against this
            // list, so the chain can mint a token that outlives the record
            // that kills it. Every refusal pushes the record out to cover the
            // token it just refused.
            keepRevocationAlive('revokedSids', 'sid', payload.sid, payload.exp);
            return null;
        }
        // A passkey the owner deleted cannot hold a session open either. That
        // record never expires: the edge re-dates a token on every visit, so
        // its life has no end and no finite record could outlive it.
        if (payload.credentialId && (store.revokedCredentials || []).some((r) => r.credentialId === payload.credentialId)) return null;
        return payload;
    } catch {
        return null;
    }
}

// Refresh on the next authenticated request once the session is a day old,
// or past half its life if that comes first. A month-long session that only
// slid at half-life sat 15 days without moving; a browser that drops the
// cookie in between then looks like an expiry.
const REFRESH_AFTER_SECONDS = 24 * 60 * 60;
export function shouldRefresh(payload) {
    if (!payload?.iat || !payload?.exp) return false;
    const total = payload.exp - payload.iat;
    const elapsed = Math.floor(Date.now() / 1000) - payload.iat;
    return elapsed > Math.min(REFRESH_AFTER_SECONDS, total / 2);
}

function expiresAt(exp) {
    return (exp || Math.floor(Date.now() / 1000) + 30 * 86400) * 1000;
}

/**
 * Keep a revocation record until after the token it just refused expires.
 * A record is dropped once it is past its own expiry, but the edge can slide
 * a cookie into a token that outlives the record, and it cannot read this
 * list to know better. Seeing the later token is the signal to hold on.
 */
function keepRevocationAlive(list, field, value, exp) {
    const until = expiresAt(exp);
    updateStore((s) => {
        const row = (s[list] || []).find((r) => r[field] === value);
        if (row && (!row.expires || row.expires < until)) row.expires = until;
        return s;
    });
}

export function revokeJti(jti, exp) {
    if (!jti) return;
    updateStore((s) => {
        s.revokedJtis = s.revokedJtis || [];
        if (!s.revokedJtis.some((r) => r.jti === jti)) {
            s.revokedJtis.push({ jti, expires: expiresAt(exp) });
        }
        return s;
    });
}

/**
 * End a session for good: the id, not the token. A refresh mints a new token
 * id but carries the session id, so this kills the chain the edge keeps
 * sliding. The token id goes on the list too, for a session issued before
 * session ids existed.
 */
export function revokeSession(payload) {
    if (!payload) return;
    const exp = payload.exp;
    if (payload.jti) revokeJti(payload.jti, exp);
    if (!payload.sid) return;
    updateStore((s) => {
        s.revokedSids = s.revokedSids || [];
        if (!s.revokedSids.some((r) => r.sid === payload.sid)) {
            s.revokedSids.push({ sid: payload.sid, expires: expiresAt(exp) });
        }
        return s;
    });
}

/** A deleted passkey takes its sessions with it. */
export function revokeCredential(credentialId) {
    if (!credentialId) return;
    updateStore((s) => {
        s.revokedCredentials = s.revokedCredentials || [];
        if (!s.revokedCredentials.some((r) => r.credentialId === credentialId)) {
            // No expiry: see verifySession. A credential id is random and is
            // never handed out twice, so the row can stay for good.
            s.revokedCredentials.push({ credentialId, revokedAt: new Date().toISOString() });
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
