// Session guard used by route handlers and server actions.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SignJWT } = require('jose');

const SECRET = 'test-session-secret-that-is-at-least-32-chars';
let mockCookieValue = null;

jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name) => (name === 'deedee_session' && mockCookieValue ? { value: mockCookieValue } : undefined),
    }),
}));

async function signedSession(secret = SECRET) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ method: 'password' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .setJti('guard-test-jti')
        .setSubject('owner')
        .sign(new TextEncoder().encode(secret));
}

describe('auth guard', () => {
    let guard;
    let dataDir;

    beforeAll(() => {
        process.env.SESSION_SECRET = SECRET;
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-auth-'));
        process.env.AUTH_DATA_DIR = dataDir;
        guard = require('../src/lib/auth/guard.js');
    });

    afterAll(() => {
        fs.rmSync(dataDir, { recursive: true, force: true });
        delete process.env.AUTH_DATA_DIR;
        delete process.env.SESSION_SECRET;
    });

    beforeEach(() => { mockCookieValue = null; });

    test('requireActionSession throws without a cookie', async () => {
        await expect(guard.requireActionSession()).rejects.toThrow('Unauthorized');
    });

    test('requireActionSession throws for a cookie signed with another secret', async () => {
        mockCookieValue = await signedSession('another-secret-that-is-also-32-chars-long!!');
        await expect(guard.requireActionSession()).rejects.toThrow('Unauthorized');
    });

    test('requireActionSession returns the payload for a valid cookie', async () => {
        mockCookieValue = await signedSession();
        const session = await guard.requireActionSession();
        expect(session.sub).toBe('owner');
        expect(session.method).toBe('password');
    });

    test('requireSession returns a 401 response without a cookie', async () => {
        const { session, response } = await guard.requireSession();
        expect(session).toBeNull();
        expect(response.status).toBe(401);
    });

    test('requireSession returns the session with a valid cookie', async () => {
        mockCookieValue = await signedSession();
        const { session, response } = await guard.requireSession();
        expect(session.sub).toBe('owner');
        expect(response).toBeNull();
    });
});
