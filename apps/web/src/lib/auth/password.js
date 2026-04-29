// Password hashing using Node's built-in scrypt (no native deps to compile
// in the alpine builder). scrypt is in OWASP's recommended list and ships
// with Node — good enough for a single-user app's once-a-month login.
import 'server-only';
import { scrypt, randomBytes, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

// scrypt cost params. N=2^15 (~64 MB / ~250ms on modern CPUs).
const N = 32768;
const r = 8;
const p = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

export async function hashPassword(password) {
    if (typeof password !== 'string' || password.length < 8) {
        throw new Error('Password must be at least 8 characters');
    }
    const salt = randomBytes(SALT_LEN);
    const derived = await scryptAsync(password, salt, KEY_LEN, { N, r, p, maxmem: 128 * N * r * 2 });
    return {
        hash: derived.toString('base64'),
        salt: salt.toString('base64'),
        params: { N, r, p, keyLen: KEY_LEN },
        updated: new Date().toISOString(),
    };
}

export async function verifyPassword(password, record) {
    if (!record?.hash || !record?.salt || !record?.params) return false;
    const { N, r, p, keyLen } = record.params;
    try {
        const expected = Buffer.from(record.hash, 'base64');
        const salt = Buffer.from(record.salt, 'base64');
        const derived = await scryptAsync(password, salt, keyLen, { N, r, p, maxmem: 128 * N * r * 2 });
        if (derived.length !== expected.length) return false;
        return timingSafeEqual(derived, expected);
    } catch (err) {
        console.error('[auth/password] verify error', err);
        return false;
    }
}
