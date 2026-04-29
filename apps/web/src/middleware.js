import { NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

// Edge runtime — keep deps minimal. We re-validate the cookie here using
// jose (works in edge) so we can short-circuit unauthenticated requests
// before they reach any route handler. Full session lib lives in
// @/lib/auth/session and runs server-side only.

const SESSION_COOKIE_NAME = 'deedee_session';

let cachedKey = null;
function secret() {
    const env = process.env.SESSION_SECRET;
    if (!env || env.length < 32) return null;
    if (!cachedKey) cachedKey = new TextEncoder().encode(env);
    return cachedKey;
}

async function isAuthed(request) {
    const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (!token) return false;
    const key = secret();
    if (!key) return false; // No secret configured -> deny by default; instrumentation logs a warning at boot.
    try {
        await jwtVerify(token, key, { algorithms: ['HS256'] });
        // We can't read the persisted JTI revocation list from the edge runtime
        // without a fetch. The server-side guard handles that on protected
        // route handlers. For middleware redirect purposes, signature + expiry
        // is sufficient: revoked tokens still get rejected on every API hit.
        return true;
    } catch {
        return false;
    }
}

// Pathnames the middleware will not gate. Login flow itself, static assets,
// the manifest/icons, and health.
const PUBLIC_PATHS = [
    /^\/login(?:\/.*)?$/,
    /^\/api\/auth\/login$/,
    /^\/api\/auth\/passkey\/login\/.*$/,
    /^\/api\/auth\/me$/,
    /^\/health$/,
    /^\/_next\/.*$/,
    /^\/favicon\.ico$/,
    /^\/site\.webmanifest$/,
    /^\/.*\.(?:png|svg|ico|jpg|jpeg|webp|woff2?|ttf|map)$/,
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

    if (await isAuthed(request)) {
        return NextResponse.next({ request: { headers: requestHeaders } });
    }

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

export const config = {
    matcher: [
        // Run on everything except Next.js internals; we filter inside.
        '/((?!_next/static|_next/image).*)',
    ],
};
