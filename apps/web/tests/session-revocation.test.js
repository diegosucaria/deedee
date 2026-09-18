// Signing out must end the session, not one token of it: the edge refresh
// mints a new token id on every slide, so revocation has to name the session.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decodeJwt, SignJWT } = require('jose');

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

describe('a revocation outlives what it must kill', () => {
    const OLD = { ...process.env };
    const dirs = [];
    afterEach(() => { process.env = { ...OLD }; });
    afterAll(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

    const readStore = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));

    test('a sign-out record is pushed out to cover a token the edge slid later', async () => {
        const { dir, session } = freshEnv(); dirs.push(dir);
        const first = await session.issueSession({ extra: { method: 'passkey' } });
        session.revokeSession(decodeJwt(first.token));
        const recorded = readStore(dir).revokedSids[0].expires;

        // The edge cannot read the store, so it keeps sliding a copied cookie
        // into a token that outlives the record that kills it. This is what
        // the edge mints: same session id, a fresh month from today.
        const now = Math.floor(Date.now() / 1000);
        const slidExp = now + 30 * 86400 + 5000;
        const slid = await new SignJWT({ method: 'passkey', sid: first.sid })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt(now).setExpirationTime(slidExp).setJti('slid-jti').setSubject('owner')
            .sign(new TextEncoder().encode(SECRET));
        expect(await session.verifySession(slid)).toBeNull();
        const after = readStore(dir).revokedSids[0].expires;
        expect(after).toBeGreaterThan(recorded);
        expect(after).toBe(slidExp * 1000);
    });

    test('a deleted passkey is refused for good, not for sixty days', async () => {
        const { dir, session } = freshEnv(); dirs.push(dir);
        const { gcStore } = require('../src/lib/auth/store.js');
        const signed = await session.issueSession({ extra: { method: 'passkey', credentialId: 'cred-1' } });
        session.revokeCredential('cred-1');
        expect(await session.verifySession(signed.token)).toBeNull();

        // A record with a date would be collected while the edge kept the
        // token alive; this one has none, so tidying cannot bring it back.
        expect(readStore(dir).revokedCredentials[0].expires).toBeUndefined();
        gcStore();
        expect(readStore(dir).revokedCredentials.map(r => r.credentialId)).toEqual(['cred-1']);
        expect(await session.verifySession(signed.token)).toBeNull();
        // A newer token signed by the same deleted passkey is refused too.
        const later = await session.issueSession({ extra: { method: 'passkey', credentialId: 'cred-1' } });
        expect(await session.verifySession(later.token)).toBeNull();
    });

    test('tidying still drops a revocation that has really run out', async () => {
        const { dir, session } = freshEnv(); dirs.push(dir);
        const { gcStore, updateStore } = require('../src/lib/auth/store.js');
        const issued = await session.issueSession({ extra: { method: 'password' } });
        session.revokeSession(decodeJwt(issued.token));
        updateStore((s) => {
            s.revokedSids[0].expires = Date.now() - 1000;
            s.revokedJtis[0].expires = Date.now() - 1000;
            return s;
        });
        gcStore();
        expect(readStore(dir).revokedSids).toEqual([]);
        expect(readStore(dir).revokedJtis).toEqual([]);
    });
});
