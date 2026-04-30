// Boot-time bootstrap. Loaded dynamically from src/instrumentation.js so
// webpack's edge-runtime bundle never has to follow these imports.
import 'server-only';
import { readStore, writeStore, gcStore } from './store.js';
import { hashPassword, verifyPassword } from './password.js';
import { passkeysEnabled } from './tls.js';

export async function bootstrap() {
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
