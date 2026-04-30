// WebAuthn / passkey ceremonies. Wraps @simplewebauthn/server. The RP
// (relying party) is the web subdomain — only this origin runs ceremonies,
// even when the session cookie is parent-domain scoped.
import 'server-only';
import {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { randomBytes } from 'crypto';
import { readStore, updateStore } from './store.js';
import { passkeyOrigin, passkeyRpId, passkeysEnabled } from './tls.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
// Single-user app — the user handle is constant. WebAuthn requires a stable
// per-user ID; we use a fixed string so re-enrolling on the same account
// doesn't fragment passkey lists.
export const OWNER_USER_ID = new TextEncoder().encode('deedee-owner');
const OWNER_USER_NAME = 'owner';
const OWNER_DISPLAY_NAME = 'DeeDee';

function rememberChallenge(challenge, kind) {
    updateStore((s) => {
        s.webauthnChallenges = s.webauthnChallenges || {};
        s.webauthnChallenges[challenge] = { kind, expires: Date.now() + CHALLENGE_TTL_MS };
        return s;
    });
}

function consumeChallenge(challenge, kind) {
    let ok = false;
    updateStore((s) => {
        const entry = s.webauthnChallenges?.[challenge];
        if (entry && entry.kind === kind && entry.expires > Date.now()) {
            ok = true;
            delete s.webauthnChallenges[challenge];
        }
        return s;
    });
    return ok;
}

function ensureEnabled() {
    if (!passkeysEnabled()) {
        const err = new Error('Passkeys disabled: WEBAUTHN_RP_ID/WEBAUTHN_ORIGIN must be set and use HTTPS (or localhost)');
        err.status = 503;
        throw err;
    }
}

export async function buildRegistrationOptions() {
    ensureEnabled();
    const store = readStore();
    const opts = await generateRegistrationOptions({
        rpName: 'DeeDee',
        rpID: passkeyRpId(),
        userID: OWNER_USER_ID,
        userName: OWNER_USER_NAME,
        userDisplayName: OWNER_DISPLAY_NAME,
        attestationType: 'none',
        excludeCredentials: (store.passkeys || []).map((c) => ({
            id: c.id,
            transports: c.transports || undefined,
        })),
        authenticatorSelection: {
            residentKey: 'preferred',
            userVerification: 'preferred',
        },
    });
    rememberChallenge(opts.challenge, 'register');
    return opts;
}

export async function finishRegistration(response, name) {
    ensureEnabled();
    const expectedChallenge = response?.response?.clientDataJSON
        ? extractChallenge(response.response.clientDataJSON) : null;
    if (!expectedChallenge || !consumeChallenge(expectedChallenge, 'register')) {
        throw new Error('Challenge expired or unknown');
    }
    const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: passkeyOrigin(),
        expectedRPID: passkeyRpId(),
        requireUserVerification: false,
    });
    if (!verification.verified || !verification.registrationInfo) {
        throw new Error('Registration verification failed');
    }
    const info = verification.registrationInfo;
    // simplewebauthn v11 nests the credential fields under `credential`.
    const cred = info.credential || info;
    const id = cred.id;
    const publicKey = Buffer.from(cred.publicKey).toString('base64url');
    const counter = cred.counter ?? 0;
    const transports = cred.transports || response.response?.transports || [];

    const record = {
        id,
        publicKey,
        counter,
        transports,
        deviceType: info.credentialDeviceType || 'unknown',
        backedUp: !!info.credentialBackedUp,
        name: (name || '').slice(0, 64) || 'Passkey',
        created: new Date().toISOString(),
        lastUsed: null,
    };
    updateStore((s) => {
        s.passkeys = s.passkeys || [];
        if (s.passkeys.some((c) => c.id === record.id)) {
            throw new Error('Passkey already registered');
        }
        s.passkeys.push(record);
        return s;
    });
    return record;
}

export async function buildAuthenticationOptions() {
    ensureEnabled();
    const store = readStore();
    const opts = await generateAuthenticationOptions({
        rpID: passkeyRpId(),
        userVerification: 'preferred',
        allowCredentials: (store.passkeys || []).map((c) => ({
            id: c.id,
            transports: c.transports || undefined,
        })),
    });
    rememberChallenge(opts.challenge, 'login');
    return opts;
}

export async function finishAuthentication(response) {
    ensureEnabled();
    const expectedChallenge = response?.response?.clientDataJSON
        ? extractChallenge(response.response.clientDataJSON) : null;
    if (!expectedChallenge || !consumeChallenge(expectedChallenge, 'login')) {
        throw new Error('Challenge expired or unknown');
    }
    const store = readStore();
    const credential = (store.passkeys || []).find((c) => c.id === response.id);
    if (!credential) throw new Error('Unknown credential');

    const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: passkeyOrigin(),
        expectedRPID: passkeyRpId(),
        credential: {
            id: credential.id,
            publicKey: Buffer.from(credential.publicKey, 'base64url'),
            counter: credential.counter,
            transports: credential.transports,
        },
        requireUserVerification: false,
    });
    if (!verification.verified) throw new Error('Authentication verification failed');

    updateStore((s) => {
        const target = s.passkeys.find((c) => c.id === credential.id);
        if (target) {
            target.counter = verification.authenticationInfo.newCounter;
            target.lastUsed = new Date().toISOString();
        }
        return s;
    });
    return credential;
}

export function listPasskeys() {
    const store = readStore();
    return (store.passkeys || []).map((c) => ({
        id: c.id,
        name: c.name,
        deviceType: c.deviceType,
        backedUp: c.backedUp,
        created: c.created,
        lastUsed: c.lastUsed,
    }));
}

export function renamePasskey(id, name) {
    let updated = false;
    updateStore((s) => {
        const target = s.passkeys?.find((c) => c.id === id);
        if (target) {
            target.name = (name || '').slice(0, 64) || target.name;
            updated = true;
        }
        return s;
    });
    return updated;
}

export function deletePasskey(id) {
    let removed = false;
    updateStore((s) => {
        const before = (s.passkeys || []).length;
        s.passkeys = (s.passkeys || []).filter((c) => c.id !== id);
        removed = s.passkeys.length < before;
        return s;
    });
    return removed;
}

function extractChallenge(clientDataJSONb64url) {
    try {
        const json = JSON.parse(Buffer.from(clientDataJSONb64url, 'base64url').toString('utf8'));
        return json.challenge;
    } catch {
        return null;
    }
}

// Generate a fresh random challenge — exposed so callers can correlate
// custom flows; not currently used externally but handy for tests.
export function freshChallenge() {
    return randomBytes(32).toString('base64url');
}
