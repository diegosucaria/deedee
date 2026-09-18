import { NextResponse } from 'next/server';
import { jwtVerify, SignJWT } from 'jose';

// Edge runtime — keep deps minimal. We re-validate the cookie here using
// jose (works in edge) so we can short-circuit unauthenticated requests
// before they reach any route handler. Full session lib lives in
// @/lib/auth/session and runs server-side only.
//
// JTI revocation is NOT enforced at this layer — auth.json is on the
// node-side filesystem and unreachable from the edge runtime. Route
// handlers that call requireSession() do enforce it. In practice this
// means a revoked-but-not-cleared cookie could still load HTML pages,
// but every API call from those pages will 401 because every protected
// /api/* handler re-checks the JTI. Logout clears the cookie in the
// browser, so this only matters for cookies that have been physically
// extracted (XSS, shared host) — out of scope for a single-user app.
const SESSION_COOKIE_NAME = 'deedee_session';
const ALG = 'HS256';
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;
// Mirrors @/lib/auth/session: a passkey session may live longer than a
// password one, and a refresh must keep the same lifetime it was issued with.
const DEFAULT_PASSKEY_TTL_SECONDS = 30 * 24 * 60 * 60;
const REFRESH_AFTER_SECONDS = 24 * 60 * 60;

let cachedKey = null;
let cachedSecret = null;
function secret() {
    const env = process.env.SESSION_SECRET;
    if (!env || env.length < 32) return null;
    if (cachedSecret !== env) {
        cachedKey = new TextEncoder().encode(env);
        cachedSecret = env;
    }
    return cachedKey;
}

// Mirrors parseTtl in @/lib/auth/session: "2592000", "30d", "12h", "45m",
// nothing else, and never under five minutes.
const MIN_TTL_SECONDS = 300;
const TTL_UNITS = { s: 1, m: 60, h: 3600, d: 86400 };
function envSeconds(name) {
    const m = /^\s*(\d+)\s*([smhd])?\s*$/i.exec(String(process.env[name] ?? ''));
    if (!m) return null;
    const seconds = parseInt(m[1], 10) * TTL_UNITS[(m[2] || 's').toLowerCase()];
    return Number.isFinite(seconds) && seconds >= MIN_TTL_SECONDS ? seconds : null;
}

function ttlSeconds(method = null) {
    if (String(method || '') === 'passkey') {
        return envSeconds('SESSION_TTL_PASSKEY_SECONDS') || envSeconds('SESSION_TTL_SECONDS') || DEFAULT_PASSKEY_TTL_SECONDS;
    }
    return envSeconds('SESSION_TTL_SECONDS') || DEFAULT_TTL_SECONDS;
}

function isProd() {
    return process.env.NODE_ENV === 'production';
}

function cookieAttributes() {
    const attrs = { httpOnly: true, sameSite: 'lax', secure: isProd(), path: '/' };
    if (process.env.COOKIE_DOMAIN) attrs.domain = process.env.COOKIE_DOMAIN;
    return attrs;
}

async function verifyToken(token) {
    if (!token) return null;
    const key = secret();
    if (!key) return null;
    try {
        const { payload } = await jwtVerify(token, key, { algorithms: [ALG] });
        return payload;
    } catch {
        return null;
    }
}

/**
 * Why a session was refused, for the log. The owner is signed out about once
 * a day and nothing recorded it, so there was no way to tell a cookie the
 * browser never sent from one the server rejected. Those two have completely
 * different causes, and this line separates them in one look.
 */
async function refusalReason(token) {
    if (!token) return 'no cookie sent';
    if (!secret()) return 'SESSION_SECRET missing or too short';
    try {
        await jwtVerify(token, secret(), { algorithms: [ALG] });
        return 'accepted';
    } catch (err) {
        const code = err?.code || err?.name || 'unknown';
        if (code === 'ERR_JWT_EXPIRED') {
            const exp = err?.payload?.exp;
            const iat = err?.payload?.iat;
            const now = Math.floor(Date.now() / 1000);
            const lived = exp && iat ? `, issued for ${Math.round((exp - iat) / 3600)}h` : '';
            const ago = exp ? `, expired ${Math.round((now - exp) / 60)} min ago` : '';
            return `expired${lived}${ago}`;
        }
        if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') return 'signature does not match SESSION_SECRET';
        return `rejected (${code})`;
    }
}

// Once a session is a day old (or past half its life, whichever comes
// first), re-issue it on the next authenticated request, so a user who keeps
// coming back never has to log in again. New JTI on each refresh; the old one
// is left to expire naturally (no revocation needed since we replace the cookie).
function shouldRefresh(payload) {
    if (!payload?.iat || !payload?.exp) return false;
    const total = payload.exp - payload.iat;
    const elapsed = Math.floor(Date.now() / 1000) - payload.iat;
    return elapsed > Math.min(REFRESH_AFTER_SECONDS, total / 2);
}

async function reissue(payload) {
    const key = secret();
    if (!key) return null;
    const ttl = ttlSeconds(payload.method);
    const now = Math.floor(Date.now() / 1000);
    const jti = crypto.randomUUID();
    const carry = {};
    if (payload.method) carry.method = payload.method;
    if (payload.credentialId) carry.credentialId = payload.credentialId;
    // The session id travels unchanged, so signing out ends every token in
    // the chain. Without it a refreshed cookie would outlive the sign-out.
    if (payload.sid) carry.sid = payload.sid;
    const token = await new SignJWT(carry)
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt(now)
        .setExpirationTime(now + ttl)
        .setJti(jti)
        .setSubject('owner')
        .sign(key);
    return { token, ttl };
}

// Pathnames the middleware will not gate. Login flow itself, OAuth
// callback (so an expired session mid-OAuth-flow doesn't drop the
// authorization code), static assets, the manifest/icons, and health.
//
// IMPORTANT: the static-asset regex is restricted to TOP-LEVEL paths
// (single segment after /) so it can't be exploited to bypass auth on
// nested route handlers that happen to take an extension. e.g. a vault
// file at /files/vaults/123/files/photo.png must NOT bypass.
const PUBLIC_PATHS = [
    /^\/login(?:\/.*)?$/,
    /^\/api\/auth\/login$/,
    /^\/api\/auth\/passkey\/login\/.*$/,
    /^\/api\/auth\/me$/,
    /^\/api\/auth\/google\/callback$/,
    /^\/health$/,
    /^\/_next\/.*$/,
    /^\/favicon\.ico$/,
    /^\/site\.webmanifest$/,
    /^\/[^/]+\.(?:png|svg|ico|jpg|jpeg|webp|woff2?|ttf|map)$/,
];

function isPublic(pathname) {
    return PUBLIC_PATHS.some((rx) => rx.test(pathname));
}

// Server actions are POSTed to whatever page the caller is on, so a public
// page like /login is enough to reach every action in the app. Detect an
// action invocation by its header (fetch from React) or by a form/flight
// body POSTed to a page (progressive enhancement, no header). Such requests
// need a session no matter which path they target.
const ACTION_CONTENT_TYPES = ['multipart/form-data', 'application/x-www-form-urlencoded', 'text/plain'];

export function isServerActionRequest(request) {
    if (request.headers.has('next-action')) return true;
    if (request.method !== 'POST') return false;
    const contentType = (request.headers.get('content-type') || '').toLowerCase();
    return ACTION_CONTENT_TYPES.some((t) => contentType.startsWith(t));
}

function unauthorizedJson() {
    return new NextResponse(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
}

export async function middleware(request) {
    const { pathname } = request.nextUrl;

    // Stamp the pathname on a request header so the root layout can decide
    // whether to render the sidebar (skip on /login).
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-deedee-path', pathname);

    // Next.js marks its own internal sub-requests with this header and used
    // to skip the middleware for them (CVE-2025-29927). No external client
    // has a reason to send it, so refuse the request outright.
    if (request.headers.has('x-middleware-subrequest')) {
        return unauthorizedJson();
    }

    const actionRequest = isServerActionRequest(request);

    if (isPublic(pathname) && !actionRequest) {
        return NextResponse.next({ request: { headers: requestHeaders } });
    }

    const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    const payload = await verifyToken(token);

    if (!payload) {
        // Unauthenticated. For HTML navigations send to /login with ?next=…
        // For API/JSON requests and server actions return 401 so client code can react.
        const accept = request.headers.get('accept') || '';
        if (actionRequest || pathname.startsWith('/api/')) {
            return unauthorizedJson();
        }
        if (!accept.includes('text/html')) {
            return new NextResponse('Unauthorized', { status: 401 });
        }
        // A page he asked for, sent to the login screen: that is the sign-out
        // he sees. One line says why, so it is not a guess next time.
        console.warn(`[auth] Sign-in required for ${pathname}: ${await refusalReason(token)}.`);
        const url = request.nextUrl.clone();
        url.pathname = '/login';
        url.searchParams.set('next', pathname + (request.nextUrl.search || ''));
        return NextResponse.redirect(url);
    }

    const res = NextResponse.next({ request: { headers: requestHeaders } });
    // Never on the way out: a refresh here would hand the browser a live
    // token while the handler revokes the one it was sent.
    if (pathname !== '/api/auth/logout' && shouldRefresh(payload)) {
        const refreshed = await reissue(payload);
        if (refreshed) {
            res.cookies.set({
                name: SESSION_COOKIE_NAME,
                value: refreshed.token,
                ...cookieAttributes(),
                maxAge: refreshed.ttl,
            });
        }
    }
    return res;
}

export const config = {
    matcher: [
        // Run on everything except Next.js internals; we filter inside.
        '/((?!_next/static|_next/image).*)',
    ],
};
