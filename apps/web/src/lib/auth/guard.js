// requireSession() — call from any route handler that should be
// session-gated. Reads the cookie via headers (works in App Router
// route handlers and server components) and returns the JWT payload
// or sends a 401.
//
// Middleware already redirects unauthenticated browser navigations to
// /login. The guard here is defense-in-depth for direct hits to the
// proxy routes (e.g. someone scraping /wardrobe_images/*).
import 'server-only';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME, verifySession } from './session.js';

export async function getSession() {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE_NAME)?.value;
    if (!token) return null;
    return verifySession(token);
}

export async function requireSession() {
    const session = await getSession();
    if (!session) {
        return { session: null, response: new NextResponse('Unauthorized', { status: 401 }) };
    }
    return { session, response: null };
}
