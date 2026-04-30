#!/usr/bin/env node
// Interactive bootstrap CLI: prompts for a password and writes it to auth.json.
// Use this when you'd rather not put LOGIN_PASSWORD in env (it's optional —
// LOGIN_PASSWORD on the web container does the same thing on every boot).
//
//   docker compose run --rm web npm run auth:init
//
// Run with `--data-dir /path` to override the store location for testing.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { scrypt, randomBytes, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');

const scryptAsync = promisify(scrypt);

const N = 32768;
const r = 8;
const p = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

function dataDir() {
    const idx = process.argv.indexOf('--data-dir');
    if (idx > 0 && process.argv[idx + 1]) return process.argv[idx + 1];
    return process.env.AUTH_DATA_DIR || '/app/data';
}

function storePath() { return path.join(dataDir(), 'auth.json'); }

function readStore() {
    const p = storePath();
    if (!fs.existsSync(p)) return { version: 1, password: null, passkeys: [], webauthnChallenges: {}, revokedJtis: [], sessionSecret: null };
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeStore(store) {
    const dir = dataDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const p = storePath();
    const tmp = `${p}.${randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, p);
    try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
}

async function hashPassword(password) {
    const salt = randomBytes(SALT_LEN);
    const derived = await scryptAsync(password, salt, KEY_LEN, { N, r, p, maxmem: 128 * N * r * 2 });
    return {
        hash: derived.toString('base64'),
        salt: salt.toString('base64'),
        params: { N, r, p, keyLen: KEY_LEN },
        updated: new Date().toISOString(),
    };
}

async function verifyPassword(password, record) {
    if (!record?.hash) return false;
    const expected = Buffer.from(record.hash, 'base64');
    const salt = Buffer.from(record.salt, 'base64');
    const derived = await scryptAsync(password, salt, record.params.keyLen, { N: record.params.N, r: record.params.r, p: record.params.p, maxmem: 128 * record.params.N * record.params.r * 2 });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function prompt(question, { silent = false } = {}) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (silent) {
        const stdin = process.stdin;
        stdin.setRawMode?.(true);
    }
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

async function readPasswordSilent(promptText) {
    process.stdout.write(promptText);
    return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        const wasRaw = stdin.isRaw;
        stdin.resume();
        stdin.setEncoding('utf8');
        if (stdin.setRawMode) stdin.setRawMode(true);
        let buf = '';
        const onData = (ch) => {
            if (ch === '\r' || ch === '\n' || ch === '') {
                stdin.removeListener('data', onData);
                if (stdin.setRawMode) stdin.setRawMode(wasRaw || false);
                stdin.pause();
                process.stdout.write('\n');
                resolve(buf);
            } else if (ch === '') { // Ctrl-C
                stdin.removeListener('data', onData);
                if (stdin.setRawMode) stdin.setRawMode(wasRaw || false);
                stdin.pause();
                process.stdout.write('\n');
                reject(new Error('Aborted'));
            } else if (ch === '' || ch === '\b') {
                buf = buf.slice(0, -1);
            } else {
                buf += ch;
            }
        };
        stdin.on('data', onData);
    });
}

async function main() {
    const args = new Set(process.argv.slice(2));
    const showCurrent = args.has('--show');
    const store = readStore();

    if (showCurrent) {
        console.log(JSON.stringify({
            dataDir: dataDir(),
            hasPassword: !!store.password,
            passkeyCount: (store.passkeys || []).length,
            updated: store.password?.updated || null,
        }, null, 2));
        return;
    }

    console.log(`DeeDee auth bootstrap`);
    console.log(`Store: ${storePath()}`);
    if (store.password) {
        console.log(`A password is already set (updated ${store.password.updated}).`);
    }
    const pw1 = await readPasswordSilent('Enter password: ');
    if (pw1.length < 8) { console.error('Password must be at least 8 characters'); process.exit(2); }
    const pw2 = await readPasswordSilent('Confirm password: ');
    if (pw1 !== pw2) { console.error('Passwords do not match'); process.exit(2); }

    const record = await hashPassword(pw1);
    store.password = record;
    writeStore(store);
    console.log('Password set. You can now sign in at /login.');

    // Sanity check
    const ok = await verifyPassword(pw1, store.password);
    if (!ok) { console.error('Self-check failed — refusing'); process.exit(3); }
}

main().catch((err) => { console.error(err); process.exit(1); });
