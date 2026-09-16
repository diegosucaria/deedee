// The global login failure bucket must only pause PASSWORD sign-in. Passkey
// options/verify and the session-gated password change keep their per-IP
// limit but never read or feed the global bucket.
jest.mock('@/lib/auth/store', () => ({
    readStore: () => ({ password: 'stored-record' }),
    writeStore: jest.fn(),
}));
jest.mock('@/lib/auth/password', () => ({
    verifyPassword: async () => false,
    hashPassword: async () => 'new-record',
}));
jest.mock('@/lib/auth/session', () => ({
    issueSession: async () => ({ token: 't', ttl: 60 }),
    buildSetCookie: (value, maxAge) => ({ name: 'deedee_session', value, maxAge }),
}));
jest.mock('@/lib/auth/webauthn', () => ({
    buildAuthenticationOptions: async () => ({ challenge: 'c', rpId: 'localhost' }),
    finishAuthentication: async () => { const e = new Error('Passkey verification failed'); e.status = 401; throw e; },
}));
jest.mock('@/lib/auth/guard', () => ({
    requireSession: async () => ({ session: { sub: 'owner' }, response: null }),
}));

const IPS = Array.from({ length: 10 }, (_, i) => `192.0.2.${i + 1}`);

function post(path, ip, body) {
    return new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify(body),
    });
}

describe('login failure bucket scope', () => {
    let login, passkeyOptions, passkeyVerify, changePassword;

    beforeEach(() => {
        jest.resetModules();
        login = require('../src/app/api/auth/login/route.js').POST;
        passkeyOptions = require('../src/app/api/auth/passkey/login/options/route.js').POST;
        passkeyVerify = require('../src/app/api/auth/passkey/login/verify/route.js').POST;
        changePassword = require('../src/app/api/auth/password/route.js').POST;
    });

    async function sprayPasswords() {
        for (const ip of IPS) {
            for (let i = 0; i < 5; i++) {
                const res = await login(post('/api/auth/login', ip, { password: 'wrong' }));
                expect(res.status).toBe(401);
            }
        }
    }

    test('50 wrong passwords from 10 IPs pause password login and say passkeys still work', async () => {
        await sprayPasswords();
        const res = await login(post('/api/auth/login', '203.0.113.9', { password: 'wrong' }));
        expect(res.status).toBe(429);
        expect(res.headers.get('Retry-After')).toMatch(/^\d+$/);
        const body = await res.json();
        expect(body.paused).toBe(true);
        expect(body.error).toMatch(/password sign-in is paused/i);
        expect(body.error).toMatch(/passkeys still work/i);
    });

    test('a per-IP block on password login does not claim a global pause', async () => {
        for (let i = 0; i < 5; i++) await login(post('/api/auth/login', '203.0.113.1', { password: 'wrong' }));
        const res = await login(post('/api/auth/login', '203.0.113.1', { password: 'wrong' }));
        expect(res.status).toBe(429);
        const body = await res.json();
        expect(body.paused).toBe(false);
        expect(body.error).not.toMatch(/paused/i);
    });

    test('passkey options and verify still answer while password login is paused', async () => {
        await sprayPasswords();
        const options = await passkeyOptions(post('/api/auth/passkey/login/options', '203.0.113.9', {}));
        expect(options.status).toBe(200);
        expect((await options.json()).challenge).toBe('c');

        // Verify reaches the authenticator check (401 from the mock), not a 429.
        const verify = await passkeyVerify(post('/api/auth/passkey/login/verify', '203.0.113.9', { id: 'x' }));
        expect(verify.status).toBe(401);
    });

    test('passkey options from an IP that sent 5 wrong passwords are still per-IP limited', async () => {
        for (let i = 0; i < 5; i++) await login(post('/api/auth/login', '203.0.113.1', { password: 'wrong' }));
        const res = await passkeyOptions(post('/api/auth/passkey/login/options', '203.0.113.1', {}));
        expect(res.status).toBe(429);
        const fresh = await passkeyOptions(post('/api/auth/passkey/login/options', '203.0.113.2', {}));
        expect(fresh.status).toBe(200);
    });

    test('50 failed passkey verifies across 10 IPs do not pause password login', async () => {
        for (const ip of IPS) {
            for (let i = 0; i < 5; i++) {
                const res = await passkeyVerify(post('/api/auth/passkey/login/verify', ip, { id: 'x' }));
                expect(res.status).toBe(401);
            }
        }
        const res = await login(post('/api/auth/login', '203.0.113.9', { password: 'wrong' }));
        expect(res.status).toBe(401);
    });

    test('50 wrong current passwords on the change-password route do not pause login', async () => {
        for (const ip of IPS) {
            for (let i = 0; i < 5; i++) {
                const res = await changePassword(post('/api/auth/password', ip, { currentPassword: 'wrong', newPassword: 'longenough1' }));
                expect(res.status).toBe(401);
            }
        }
        const res = await login(post('/api/auth/login', '203.0.113.9', { password: 'wrong' }));
        expect(res.status).toBe(401);
        const options = await passkeyOptions(post('/api/auth/passkey/login/options', '203.0.113.9', {}));
        expect(options.status).toBe(200);
    });

    test('change-password keeps its per-IP limit', async () => {
        for (let i = 0; i < 5; i++) await changePassword(post('/api/auth/password', '203.0.113.1', { currentPassword: 'wrong', newPassword: 'longenough1' }));
        const res = await changePassword(post('/api/auth/password', '203.0.113.1', { currentPassword: 'wrong', newPassword: 'longenough1' }));
        expect(res.status).toBe(429);
    });
});
