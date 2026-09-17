// Middleware gate: session cookie check plus the two request shapes that
// must never bypass it — server action invocations and Next.js internal
// sub-request markers.
const { NextRequest } = require('next/server');
const { SignJWT, decodeJwt } = require('jose');

const SECRET = 'test-session-secret-that-is-at-least-32-chars';

async function signedSession(overrides = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ method: 'password' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .setJti('test-jti')
        .setSubject('owner')
        .sign(new TextEncoder().encode(overrides.secret || SECRET));
}

function makeRequest(path, { method = 'GET', headers = {}, cookie } = {}) {
    const h = new Headers(headers);
    if (cookie) h.set('cookie', `deedee_session=${cookie}`);
    return new NextRequest(`http://localhost${path}`, { method, headers: h });
}

describe('web middleware', () => {
    let middleware;
    let isServerActionRequest;

    beforeAll(() => {
        process.env.SESSION_SECRET = SECRET;
        ({ middleware, isServerActionRequest } = require('../src/middleware.js'));
    });

    afterAll(() => {
        delete process.env.SESSION_SECRET;
    });

    test('public GET passes without a session', async () => {
        const res = await middleware(makeRequest('/login'));
        expect(res.status).toBe(200);
        expect(res.headers.get('x-middleware-next')).toBe('1');
    });

    test('protected page without a session redirects to /login', async () => {
        const res = await middleware(makeRequest('/tasks', { headers: { accept: 'text/html' } }));
        expect(res.status).toBe(307);
        expect(new URL(res.headers.get('location')).pathname).toBe('/login');
    });

    test('protected API path without a session returns 401 JSON', async () => {
        const res = await middleware(makeRequest('/api/tasks'));
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });

    test('valid session on a protected page passes', async () => {
        const cookie = await signedSession();
        const res = await middleware(makeRequest('/tasks', { cookie }));
        expect(res.status).toBe(200);
        expect(res.headers.get('x-middleware-next')).toBe('1');
    });

    test('tampered session cookie is rejected', async () => {
        const cookie = await signedSession({ secret: 'another-secret-that-is-also-32-chars-long!!' });
        const res = await middleware(makeRequest('/api/tasks', { cookie }));
        expect(res.status).toBe(401);
    });

    describe('server action invocations', () => {
        test('next-action header on a public path without a session returns 401', async () => {
            const res = await middleware(makeRequest('/login', {
                method: 'POST',
                headers: { 'next-action': 'abc123', 'content-type': 'text/plain;charset=UTF-8' },
            }));
            expect(res.status).toBe(401);
            expect(await res.json()).toEqual({ error: 'Unauthorized' });
        });

        test('header name is matched case-insensitively', async () => {
            const res = await middleware(makeRequest('/login', {
                method: 'POST',
                headers: { 'Next-Action': 'abc123' },
            }));
            expect(res.status).toBe(401);
        });

        test('form POST to a public page without a session returns 401', async () => {
            const res = await middleware(makeRequest('/login', {
                method: 'POST',
                headers: { 'content-type': 'multipart/form-data; boundary=x' },
            }));
            expect(res.status).toBe(401);
        });

        test('next-action header with a valid session passes', async () => {
            const cookie = await signedSession();
            const res = await middleware(makeRequest('/login', {
                method: 'POST',
                headers: { 'next-action': 'abc123' },
                cookie,
            }));
            expect(res.status).toBe(200);
            expect(res.headers.get('x-middleware-next')).toBe('1');
        });

        test('JSON POST to the public login API stays public', async () => {
            const res = await middleware(makeRequest('/api/auth/login', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
            }));
            expect(res.status).toBe(200);
            expect(res.headers.get('x-middleware-next')).toBe('1');
        });

        test('isServerActionRequest ignores plain GETs', () => {
            expect(isServerActionRequest(makeRequest('/login'))).toBe(false);
            expect(isServerActionRequest(makeRequest('/login', { method: 'POST', headers: { 'content-type': 'application/json' } }))).toBe(false);
            expect(isServerActionRequest(makeRequest('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } }))).toBe(true);
        });
    });

    describe('x-middleware-subrequest', () => {
        test('is refused even with a valid session', async () => {
            const cookie = await signedSession();
            const res = await middleware(makeRequest('/tasks', {
                headers: { 'x-middleware-subrequest': 'middleware:middleware:middleware:middleware:middleware' },
                cookie,
            }));
            expect(res.status).toBe(401);
        });

        test('is refused on public paths', async () => {
            const res = await middleware(makeRequest('/login', { headers: { 'x-middleware-subrequest': 'middleware' } }));
            expect(res.status).toBe(401);
        });
    });
});


// The refresh rule that actually runs in production lives in the middleware,
// not in the session library: it slides the cookie and must carry the session
// id, keep the lifetime the sign-in earned, and never fire on the way out.
describe('sliding the session at the edge', () => {
    const DAY = 24 * 60 * 60;
    let middleware;

    beforeAll(() => {
        process.env.SESSION_SECRET = SECRET;
        ({ middleware } = require('../src/middleware.js'));
    });

    afterAll(() => { delete process.env.SESSION_SECRET; });

    async function tokenAged(days, extra = {}) {
        const now = Math.floor(Date.now() / 1000);
        return new SignJWT({ method: 'passkey', sid: 'session-1', credentialId: 'cred-1', ...extra })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt(now - days * DAY)
            .setExpirationTime(now + (30 - days) * DAY)
            .setJti('old-jti')
            .setSubject('owner')
            .sign(new TextEncoder().encode(SECRET));
    }

    const setCookie = (res) => res.headers.getSetCookie?.().find(c => c.startsWith('deedee_session=')) || res.headers.get('set-cookie');

    test('a session older than a day is re-issued, with the same session id and a full month', async () => {
        const res = await middleware(makeRequest('/tasks', { cookie: await tokenAged(2) }));
        const cookie = setCookie(res);
        expect(cookie).toBeTruthy();
        const value = cookie.split(';')[0].replace('deedee_session=', '');
        const payload = decodeJwt(value);
        expect(payload.sid).toBe('session-1');
        expect(payload.method).toBe('passkey');
        expect(payload.credentialId).toBe('cred-1');
        expect(payload.jti).not.toBe('old-jti');
        expect(payload.exp - payload.iat).toBe(30 * DAY);
        expect(cookie).toMatch(/Max-Age=2592000/);
    });

    test('a session younger than a day is left alone', async () => {
        const res = await middleware(makeRequest('/tasks', { cookie: await tokenAged(0) }));
        expect(setCookie(res)).toBeFalsy();
    });

    test('signing out is never a refresh', async () => {
        const res = await middleware(makeRequest('/api/auth/logout', { method: 'POST', cookie: await tokenAged(2) }));
        expect(setCookie(res)).toBeFalsy();
    });
});
