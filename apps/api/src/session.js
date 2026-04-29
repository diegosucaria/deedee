// Verify the same session JWT issued by apps/web. The api uses this only
// on /socket.io to gate browser WebSocket upgrades. The DEEDEE_API_TOKEN
// bearer middleware on /v1/* is unaffected — that path is for iOS
// Shortcuts / cron / service-to-service callers and never sees a cookie.
const { jwtVerify } = require('jose');
const cookie = require('cookie');

const SESSION_COOKIE_NAME = 'deedee_session';
const ALG = 'HS256';

let cachedKey = null;
let cachedSecret = null;

function loadKey() {
    const secret = process.env.SESSION_SECRET;
    if (!secret || secret.length < 32) return null;
    if (cachedSecret !== secret) {
        cachedKey = new TextEncoder().encode(secret);
        cachedSecret = secret;
    }
    return cachedKey;
}

function extractCookie(req) {
    const header = req.headers?.cookie;
    if (!header) return null;
    try {
        const parsed = cookie.parse(header);
        return parsed[SESSION_COOKIE_NAME] || null;
    } catch {
        return null;
    }
}

async function verifySession(req) {
    const token = extractCookie(req);
    if (!token) return null;
    const key = loadKey();
    if (!key) return null;
    try {
        const { payload } = await jwtVerify(token, key, { algorithms: [ALG] });
        return payload;
    } catch {
        return null;
    }
}

module.exports = { verifySession, SESSION_COOKIE_NAME };
