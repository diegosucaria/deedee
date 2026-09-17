// Signing out must end the session, not one token of it: the edge refresh
// mints a new token id on every slide, so revocation has to name the session.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decodeJwt } = require('jose');

const SECRET = 'test-session-secret-that-is-at-least-32-chars';

function freshEnv(extra = {}) {
    jest.resetModules();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-auth-'));
    process.env.SESSION_SECRET = SECRET;
    process.env.AUTH_DATA_DIR = dir;
    for (const k of ['SESSION_TTL_SECONDS', 'SESSION_TTL_PASSKEY_SECONDS']) delete process.env[k];
    Object.assign(process.env, extra);
    return { dir, session: require('../src/lib/auth/session.js') };
}

describe('ending a session', () => {
    const OLD = { ...process.env };
    const dirs = [];
    afterEach(() => { process.env = { ...OLD }; });
    afterAll(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

    test('a session carries an id that survives a refresh', async () => {
        const { dir, session } = freshEnv(); dirs.push(dir);
        const first = await session.issueSession({ extra: { method: 'passkey' } });
        expect(first.sid).toEqual(expect.any(String));
        const refreshed = await session.issueSession({ extra: { method: 'passkey', sid: first.sid } });
        expect(decodeJwt(refreshed.token).sid).toBe(first.sid);
        expect(decodeJwt(refreshed.token).jti).not.toBe(decodeJwt(first.token).jti);
    });

    test('signing out kills every token of that session, refreshed ones included', async () => {
        const { dir, session } = freshEnv(); dirs.push(dir);
        const first = await session.issueSession({ extra: { method: 'passkey' } });
        const slid = await session.issueSession({ extra: { method: 'passkey', sid: first.sid } });
        expect(await session.verifySession(slid.token)).toBeTruthy();

        session.revokeSession(decodeJwt(first.token));
        expect(await session.verifySession(first.token)).toBeNull();
        expect(await session.verifySession(slid.token)).toBeNull();

        // A token minted after the sign-out, carrying the same session id, is dead too.
        const laundered = await session.issueSession({ extra: { method: 'passkey', sid: first.sid } });
        expect(await session.verifySession(laundered.token)).toBeNull();
    });

    test('another session is untouched', async () => {
        const { dir, session } = freshEnv(); dirs.push(dir);
        const phone = await session.issueSession({ extra: { method: 'passkey' } });
        const laptop = await session.issueSession({ extra: { method: 'passkey' } });
        session.revokeSession(decodeJwt(phone.token));
        expect(await session.verifySession(phone.token)).toBeNull();
        expect(await session.verifySession(laptop.token)).toBeTruthy();
    });

    test('deleting a passkey ends the sessions it signed in', async () => {
        const { dir, session } = freshEnv(); dirs.push(dir);
        const withKey = await session.issueSession({ extra: { method: 'passkey', credentialId: 'cred-1' } });
        const other = await session.issueSession({ extra: { method: 'passkey', credentialId: 'cred-2' } });
        session.revokeCredential('cred-1');
        expect(await session.verifySession(withKey.token)).toBeNull();
        expect(await session.verifySession(other.token)).toBeTruthy();
    });

    test('a session issued before session ids existed still revokes by token id', async () => {
        const { dir, session } = freshEnv(); dirs.push(dir);
        const issued = await session.issueSession({ extra: { method: 'password' } });
        const payload = decodeJwt(issued.token);
        session.revokeSession({ jti: payload.jti, exp: payload.exp }); // no sid
        expect(await session.verifySession(issued.token)).toBeNull();
    });

    test('a lifetime setting is read as time, not as a number of seconds when it says days', async () => {
        const { session } = freshEnv();
        expect(session.parseTtl('30d')).toBe(30 * 86400);
        expect(session.parseTtl('12h')).toBe(12 * 3600);
        expect(session.parseTtl('2592000')).toBe(2592000);
        // Nonsense, or too short to be meant, is ignored so the default holds.
        expect(session.parseTtl('90 days')).toBeNull();
        expect(session.parseTtl('forever')).toBeNull();
        expect(session.parseTtl('30')).toBeNull();
        expect(session.parseTtl('-1')).toBeNull();
        expect(session.parseTtl('')).toBeNull();
    });
});
