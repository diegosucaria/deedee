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

function ttlSeconds() {
    const v = parseInt(process.env.SESSION_TTL_SECONDS || '', 10);
    return Number.isFinite(v) && v > 60 ? v : DEFAULT_TTL_SECONDS;
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

// Once a session is past half its TTL, re-issue it on the next
// authenticated request so a user who keeps coming back never has to
// log in again. New JTI on each refresh; the old one is left to expire
// naturally (no revocation needed since we replace the cookie).
function shouldRefresh(payload) {
    if (!payload?.iat || !payload?.exp) return false;
    const total = payload.exp - payload.iat;
    const elapsed = Math.floor(Date.now() / 1000) - payload.iat;
    return elapsed > total / 2;
}

async function reissue(payload) {
    const key = secret();
    if (!key) return null;
    const ttl = ttlSeconds();
    const now = Math.floor(Date.now() / 1000);
    const jti = crypto.randomUUID();
    const carry = {};
    if (payload.method) carry.method = payload.method;
    if (payload.credentialId) carry.credentialId = payload.credentialId;
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

export async function middleware(request) {
    const { pathname } = request.nextUrl;

    // Stamp the pathname on a request header so the root layout can decide
    // whether to render the sidebar (skip on /login).
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-deedee-path', pathname);

    if (isPublic(pathname)) {
        return NextResponse.next({ request: { headers: requestHeaders } });
    }

    const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    const payload = await verifyToken(token);

    if (!payload) {
        // Unauthenticated. For HTML navigations send to /login with ?next=…
        // For API/JSON requests return 401 so client code can react.
        const accept = request.headers.get('accept') || '';
        if (pathname.startsWith('/api/')) {
            return new NextResponse(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        if (!accept.includes('text/html')) {
            return new NextResponse('Unauthorized', { status: 401 });
        }
        const url = request.nextUrl.clone();
        url.pathname = '/login';
        url.searchParams.set('next', pathname + (request.nextUrl.search || ''));
        return NextResponse.redirect(url);
    }

    const res = NextResponse.next({ request: { headers: requestHeaders } });
    if (shouldRefresh(payload)) {
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
