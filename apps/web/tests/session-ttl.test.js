// How long a session lives, by how the owner signed in. A passkey is the
// strong sign-in, so it may outlive a password session.
const { decodeJwt } = require('jose');

const SECRET = 'test-session-secret-that-is-at-least-32-chars';
const DAY = 24 * 60 * 60;

async function issue(method, env = {}) {
    jest.resetModules();
    process.env.SESSION_SECRET = SECRET;
    for (const k of ['SESSION_TTL_SECONDS', 'SESSION_TTL_PASSKEY_SECONDS']) delete process.env[k];
    Object.assign(process.env, env);
    const { issueSession } = require('../src/lib/auth/session.js');
    const { token, ttl } = await issueSession({ extra: { method } });
    const payload = decodeJwt(token);
    return { ttl, life: payload.exp - payload.iat, method: payload.method };
}

describe('session lifetime', () => {
    const OLD = { ...process.env };
    afterEach(() => { process.env = { ...OLD }; });

    test('a passkey session lasts a month, and says so in the token', async () => {
        const s = await issue('passkey');
        expect(s.ttl).toBe(30 * DAY);
        expect(s.life).toBe(30 * DAY);
        expect(s.method).toBe('passkey');
    });

    test('a password session takes the general setting', async () => {
        expect((await issue('password')).ttl).toBe(30 * DAY);
        expect((await issue('password', { SESSION_TTL_SECONDS: String(2 * DAY) })).ttl).toBe(2 * DAY);
    });

    test('the passkey setting wins for passkeys, and the general one is its fallback', async () => {
        expect((await issue('passkey', { SESSION_TTL_PASSKEY_SECONDS: String(90 * DAY) })).ttl).toBe(90 * DAY);
        // A shorter general setting does not shorten passkeys unless it is the only one.
        expect((await issue('passkey', { SESSION_TTL_PASSKEY_SECONDS: String(90 * DAY), SESSION_TTL_SECONDS: String(DAY) })).ttl).toBe(90 * DAY);
        expect((await issue('passkey', { SESSION_TTL_SECONDS: String(2 * DAY) })).ttl).toBe(2 * DAY);
        expect((await issue('passkey', { SESSION_TTL_PASSKEY_SECONDS: '30' })).ttl).toBe(30 * DAY);
    });

    test('a session refreshes once it is a day old, not at half a month', () => {
        jest.resetModules();
        process.env.SESSION_SECRET = SECRET;
        const { shouldRefresh } = require('../src/lib/auth/session.js');
        const now = Math.floor(Date.now() / 1000);
        const month = { iat: now - 2 * DAY, exp: now + 28 * DAY };
        expect(shouldRefresh(month)).toBe(true);
        expect(shouldRefresh({ iat: now - 60, exp: now + 30 * DAY })).toBe(false);
        // A short session still refreshes at half its life.
        expect(shouldRefresh({ iat: now - 3600, exp: now + 1800 })).toBe(true);
        expect(shouldRefresh({})).toBe(false);
    });
});
