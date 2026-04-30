// Boot-time bootstrap. Loaded dynamically from src/instrumentation.js so
// webpack's edge-runtime bundle never has to follow these imports.
import 'server-only';
import fs from 'fs';
import path from 'path';
import { readStore, writeStore, gcStore } from './store.js';
import { hashPassword, verifyPassword } from './password.js';
import { passkeysEnabled } from './tls.js';

const PERMS_HINT = '[auth/bootstrap] auth data dir is not writable by uid %d. The web container must run the bundled docker-entrypoint.sh (which chowns /app/data to 1001). If you are upgrading from a build that didn\'t include the entrypoint, remove the web-data volume so it gets recreated, or chown it manually on the host.';

function probeWritable() {
    const dir = process.env.AUTH_DATA_DIR || '/app/data';
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, `.write-probe-${process.pid}`);
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        return { writable: true, dir };
    } catch (err) {
        return { writable: false, dir, code: err.code, message: err.message };
    }
}

export async function bootstrap() {
    const probe = probeWritable();
    if (!probe.writable) {
        const uid = (typeof process.getuid === 'function') ? process.getuid() : -1;
        console.error(`[auth/bootstrap] Cannot write to ${probe.dir}: ${probe.code || ''} ${probe.message}`);
        console.error(PERMS_HINT.replace('%d', String(uid)));
        // Don't try further writes — they'd all fail with the same error and
        // pollute the logs. Print the auth posture and return.
        console.warn('[auth] startup aborted bootstrap due to data-dir permissions; /login will refuse all password attempts until the volume is fixed and the container is restarted.');
        return;
    }

    try {
        gcStore();
    } catch (err) {
        console.error('[auth/bootstrap] gc failed', err);
    }

    const envPassword = process.env.LOGIN_PASSWORD;
    if (envPassword) {
        try {
            const store = readStore();
            const matches = store.password ? await verifyPassword(envPassword, store.password) : false;
            if (!matches) {
                const record = await hashPassword(envPassword);
                store.password = record;
                writeStore(store);
                console.log('[auth/bootstrap] LOGIN_PASSWORD applied to auth.json (env wins).');
            } else {
                console.log('[auth/bootstrap] LOGIN_PASSWORD matches stored hash — no change.');
            }
        } catch (err) {
            console.error('[auth/bootstrap] Failed to apply LOGIN_PASSWORD:', err.message);
        }
    }

    const store = readStore();
    const hasPassword = !!store.password?.hash;
    const passkeyCount = (store.passkeys || []).length;
    const sessionSecretSource = process.env.SESSION_SECRET ? 'env' : (store.sessionSecret ? 'store' : 'missing');
    const passkey = passkeysEnabled() ? 'enabled' : 'disabled';

    console.log(`[auth] password=${hasPassword ? 'set' : 'UNSET'} passkeys=${passkeyCount} sessionSecret=${sessionSecretSource} passkey-routes=${passkey}`);
    if (!hasPassword) {
        console.warn('[auth] No password configured. Run `npm run auth:init` or set LOGIN_PASSWORD env var. The /login page will refuse password attempts until then.');
    }
}
