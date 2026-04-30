// Single-user auth store. Lives at $AUTH_DATA_DIR/auth.json (default
// /app/data inside the container, mounted from the web-data volume).
// Atomic writes via tmp + rename. Only the web service touches this file.
import 'server-only';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

const DEFAULT_DATA_DIR = '/app/data';

function dataDir() {
    return process.env.AUTH_DATA_DIR || DEFAULT_DATA_DIR;
}

function storePath() {
    return path.join(dataDir(), 'auth.json');
}

function emptyStore() {
    return {
        version: 1,
        password: null,            // { hash, salt, params, updated }
        passkeys: [],              // [{ id, publicKey, counter, transports, deviceType, name, created, lastUsed }]
        webauthnChallenges: {},    // { challenge: { kind, expires, userId? } }
        revokedJtis: [],           // [{ jti, expires }]
        sessionSecret: null,       // optional persisted secret (env wins if set)
    };
}

function ensureDir() {
    const dir = dataDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function readStore() {
    ensureDir();
    const p = storePath();
    if (!fs.existsSync(p)) return emptyStore();
    try {
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        return { ...emptyStore(), ...parsed };
    } catch (err) {
        console.error('[auth/store] Failed to read auth.json — refusing to overwrite. Inspect the file.', err);
        throw new Error('Auth store is corrupt; refusing to start');
    }
}

export function writeStore(store) {
    ensureDir();
    const p = storePath();
    const tmp = `${p}.${randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, p);
    try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
}

export function updateStore(mutator) {
    const store = readStore();
    const next = mutator(store) || store;
    writeStore(next);
    return next;
}

// Garbage-collect expired challenges and revoked JTIs.
export function gcStore() {
    const now = Date.now();
    return updateStore((store) => {
        for (const [k, v] of Object.entries(store.webauthnChallenges)) {
            if (!v?.expires || v.expires < now) delete store.webauthnChallenges[k];
        }
        store.revokedJtis = (store.revokedJtis || []).filter((r) => r.expires > now);
        return store;
    });
}
