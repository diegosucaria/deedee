/**
 * On 2026-10-09 the assistant session sat in 'connecting' for four days.
 * WhatsApp answered a reconnect with an HTTP error and hung up; Baileys
 * swallows that answer, so no 'close' came, nothing retried, and connect()
 * refused every new try because one was "already connecting". Every send
 * failed with "Connection Closed" and the owner was not told.
 */
const EventEmitter = require('events');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');
const { WhatsAppService } = require('../src/whatsapp');

jest.mock('axios');
const axios = require('axios');

const until = async (check, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (check()) return true;
        await new Promise(r => setTimeout(r, 5));
    }
    return check();
};

function fakeSocket() {
    const ev = new EventEmitter();
    const sock = {
        ev,
        ws: new EventEmitter(),
        sendPresenceUpdate: jest.fn().mockResolvedValue(undefined),
        end: jest.fn(err => ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: err, date: new Date() } })),
    };
    return sock;
}

// A finished pairing: creds.json with the account's own id.
const paired = (svc) => fs.writeFileSync(path.join(svc.authFolder, 'creds.json'), JSON.stringify({ me: { id: '15550100:1@s.whatsapp.net' } }));

function fakeBaileys(overrides = {}) {
    const sockets = [];
    const baileys = {
        default: jest.fn(() => { const s = fakeSocket(); sockets.push(s); return s; }),
        useMultiFileAuthState: jest.fn(async () => ({ state: {}, saveCreds: jest.fn() })),
        fetchLatestBaileysVersion: jest.fn(async () => ({ version: [2, 3000, 0], isLatest: true })),
        DisconnectReason: { loggedOut: 401, connectionClosed: 428 },
        delay: jest.fn(),
        downloadMediaMessage: jest.fn(),
        ...overrides,
    };
    return { baileys, sockets };
}

describe('a WhatsApp connect try that never ends', () => {
    let wa;
    let envBefore;

    beforeEach(() => {
        jest.clearAllMocks();
        ['log', 'warn', 'error'].forEach(m => jest.spyOn(console, m).mockImplementation(() => { }));
        axios.post.mockResolvedValue({ data: { received: true } });
        envBefore = { ...process.env };
        delete process.env.WHATSAPP_CONNECT_WATCHDOG;
        delete process.env.WHATSAPP_DOWN_ALERT;
        process.env.ALLOWED_WHATSAPP_NUMBERS = '15550100';
        wa = new WhatsAppService('http://agent.test', `wd-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        // Short, exact delays: 10 ms, then twice as long each try, no jitter.
        wa.reconnectConfig = { initialMs: 10, maxMs: 1000, factor: 2, jitter: 0 };
        wa.connectWatchdogMs = 40;
    });

    afterEach(() => {
        for (const t of [wa.reconnectTimeout, wa.connectWatchdog, wa.downAlertTimer, wa.sleepTimeout]) if (t) clearTimeout(t);
        if (wa.heartbeatTimer) clearInterval(wa.heartbeatTimer);
        wa.reconnectTimeout = null;
        wa.connectTry++;
        if (wa.store) {
            clearInterval(wa.store.queueFlushInterval);
            wa.store.close();
        }
        fs.rmSync(wa.authFolder, { recursive: true, force: true });
        process.env = envBefore;
        jest.restoreAllMocks();
    });

    test.each([
        [503, 'Service Unavailable'],
        // An HTTP 401 on the upgrade is not a WhatsApp logout: it must not wipe the login.
        [401, 'Unauthorized'],
    ])('a refused upgrade (HTTP %i, line closed) ends the try and schedules a reconnect', async (code, reason) => {
        // The real Baileys socket against a server that answers the upgrade
        // with an HTTP error and hangs up, as WhatsApp did on 2026-10-09.
        const server = http.createServer();
        server.on('upgrade', (req, socket) => {
            socket.end(`HTTP/1.1 ${code} ${reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
        });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        const url = `ws://127.0.0.1:${server.address().port}/ws`;
        try {
            const real = await import(pathToFileURL(require.resolve('@whiskeysockets/baileys')).href);
            const pino = require('pino');
            jest.spyOn(wa, '_importBaileys').mockResolvedValue({
                ...real,
                default: (cfg) => real.default({ ...cfg, waWebSocketUrl: url, logger: pino({ level: 'silent' }) }),
                fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0], isLatest: true }),
            });
            // The watchdog must not be what saves it here.
            wa.connectWatchdogMs = 60 * 60 * 1000;
            const scheduled = jest.spyOn(wa, '_scheduleReconnect');

            await wa.connect();

            expect(await until(() => scheduled.mock.calls.length > 0)).toBe(true);
            expect(scheduled).toHaveBeenCalledWith('Connection Lost');
            expect(wa.status).toBe('disconnected');
            expect(wa.reconnectTimeout).not.toBeNull();
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`refused the connection (HTTP ${code})`));
            // Not a logout: the login folder stays, and no "logged out" alert.
            expect(fs.existsSync(wa.authFolder)).toBe(true);
            expect(axios.post).not.toHaveBeenCalled();
        } finally {
            if (wa.reconnectTimeout) clearTimeout(wa.reconnectTimeout);
            wa.reconnectTimeout = null;
            await new Promise(r => server.close(r));
        }
    });

    test('the watchdog ends a try that never opens and retries with a delay that doubles', async () => {
        const { baileys, sockets } = fakeBaileys();
        jest.spyOn(wa, '_importBaileys').mockResolvedValue(baileys);
        const delays = [];
        const backoff = wa.calculateBackoff.bind(wa);
        jest.spyOn(wa, 'calculateBackoff').mockImplementation(() => { const d = backoff(); delays.push(d); return d; });

        await wa.connect();
        expect(wa.status).toBe('connecting');

        // Three stuck tries in a row: each one is ended and the next waits longer.
        expect(await until(() => sockets.length >= 4)).toBe(true);
        expect(delays.slice(0, 3)).toEqual([10, 20, 40]);
        // One retry per stuck try: the close of the socket it ended is not a second one.
        expect(delays.length).toBeLessThanOrEqual(sockets.length);
        expect(sockets[0].end).toHaveBeenCalledWith(expect.objectContaining({ output: { statusCode: 408 } }));

        // A connection that opens resets the delay.
        const current = sockets[sockets.length - 1];
        expect(wa.sock).toBe(current);
        current.ev.emit('connection.update', { connection: 'open' });
        expect(await until(() => wa.status === 'connected')).toBe(true);
        expect(wa.reconnectAttempts).toBe(0);
        expect(wa.connectWatchdog).toBeNull();
    });

    test('an old socket that closes late does not touch the one that replaced it', async () => {
        const { baileys, sockets } = fakeBaileys();
        jest.spyOn(wa, '_importBaileys').mockResolvedValue(baileys);
        await wa.connect();
        expect(await until(() => sockets.length >= 2)).toBe(true);
        sockets[1].ev.emit('connection.update', { connection: 'open' });
        expect(await until(() => wa.status === 'connected')).toBe(true);

        const scheduled = jest.spyOn(wa, '_scheduleReconnect');
        sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
        sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
        await new Promise(r => setTimeout(r, 20));
        expect(wa.status).toBe('connected');
        expect(wa.sock).toBe(sockets[1]);
        expect(scheduled).not.toHaveBeenCalled();
        expect(fs.existsSync(wa.authFolder)).toBe(true);
    });

    test('a try stuck before its socket exists stops when a newer try began', async () => {
        let releaseFirst;
        const firstFetch = new Promise(r => { releaseFirst = r; });
        const fetchLatestBaileysVersion = jest.fn()
            .mockImplementationOnce(() => firstFetch)
            .mockResolvedValue({ version: [2, 3000, 0], isLatest: true });
        const { baileys, sockets } = fakeBaileys({ fetchLatestBaileysVersion });
        jest.spyOn(wa, '_importBaileys').mockResolvedValue(baileys);

        const first = wa.connect();
        // The watchdog gives up on it; the retry makes the only socket.
        expect(await until(() => sockets.length === 1)).toBe(true);
        sockets[0].ev.emit('connection.update', { connection: 'open' });
        expect(await until(() => wa.status === 'connected')).toBe(true);

        // The first try wakes up late and must not open a second socket.
        releaseFirst({ version: [2, 3000, 0], isLatest: true });
        await first;
        expect(sockets).toHaveLength(1);
        expect(wa.sock).toBe(sockets[0]);
        expect(wa.status).toBe('connected');
    });

    test('a version lookup that hangs does not hold the try: Baileys keeps its own version', async () => {
        // fetchLatestBaileysVersion reads GitHub and can wait 5 minutes,
        // longer than the watchdog, which would end every try.
        wa.versionFetchTimeoutMs = 20;
        const fetchLatestBaileysVersion = jest.fn(() => new Promise(() => { }));
        const { baileys, sockets } = fakeBaileys({ fetchLatestBaileysVersion });
        jest.spyOn(wa, '_importBaileys').mockResolvedValue(baileys);
        await wa.connect();
        expect(sockets).toHaveLength(1);
        const cfg = baileys.default.mock.calls[0][0];
        // The key is left out, not set to undefined: Baileys spreads its
        // defaults first, and an undefined would replace its version.
        expect('version' in cfg).toBe(false);

        // A lookup that answers keeps the version it found.
        const { baileys: b2 } = fakeBaileys();
        const wa2 = new WhatsAppService('http://agent.test', `${wa.sessionId}-2`);
        jest.spyOn(wa2, '_importBaileys').mockResolvedValue(b2);
        try {
            await wa2.connect();
            expect(b2.default.mock.calls[0][0].version).toEqual([2, 3000, 0]);
        } finally {
            wa2._clearConnectWatchdog();
            clearInterval(wa2.store.queueFlushInterval);
            wa2.store.close();
            fs.rmSync(wa2.authFolder, { recursive: true, force: true });
        }
    });

    test('a stuck try that wakes during the backoff wait does not open a socket', async () => {
        wa.reconnectConfig = { initialMs: 300, maxMs: 1000, factor: 2, jitter: 0 };
        let releaseFirst;
        const fetchLatestBaileysVersion = jest.fn()
            .mockImplementationOnce(() => new Promise(r => { releaseFirst = r; }))
            .mockResolvedValue({ version: [2, 3000, 0], isLatest: true });
        const { baileys, sockets } = fakeBaileys({ fetchLatestBaileysVersion });
        jest.spyOn(wa, '_importBaileys').mockResolvedValue(baileys);

        const first = wa.connect();
        // The watchdog ended it; the retry waits 300 ms.
        expect(await until(() => wa.status === 'disconnected' && wa.reconnectTimeout !== null)).toBe(true);
        releaseFirst({ version: [2, 3000, 0], isLatest: true });
        await first;
        expect(sockets).toHaveLength(0);
        // The retry makes the one socket.
        expect(await until(() => sockets.length === 1)).toBe(true);
    });

    test('a disconnect stops a try in flight: no socket with a login about to be deleted', async () => {
        let release;
        const fetchLatestBaileysVersion = jest.fn(() => new Promise(r => { release = r; }));
        const { baileys, sockets } = fakeBaileys({ fetchLatestBaileysVersion });
        jest.spyOn(wa, '_importBaileys').mockResolvedValue(baileys);

        const first = wa.connect();
        expect(await until(() => typeof release === 'function')).toBe(true);
        await wa.disconnect(true);
        release({ version: [2, 3000, 0], isLatest: true });
        await first;
        expect(sockets).toHaveLength(0);
        expect(wa.status).toBe('disconnected');
    });

    test('his own Disconnect is not reported as a logout by WhatsApp', async () => {
        // Baileys' logout() ends the socket with a 401 close at once, while
        // the service still held it: the owner got "WhatsApp logged out".
        paired(wa);
        const { baileys, sockets } = fakeBaileys();
        jest.spyOn(wa, '_importBaileys').mockResolvedValue(baileys);
        await wa.connect();
        const sock = sockets[0];
        sock.ev.emit('connection.update', { connection: 'open' });
        expect(await until(() => wa.status === 'connected')).toBe(true);
        sock.logout = jest.fn(async () => {
            sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
        });

        await wa.disconnect(true);

        expect(sock.logout).toHaveBeenCalledTimes(1);
        expect(axios.post).not.toHaveBeenCalled();
        expect(fs.existsSync(wa.authFolder)).toBe(false);
    });

    test('a Disconnect on a socket still connecting ends it, though logout fails', async () => {
        const { baileys, sockets } = fakeBaileys();
        jest.spyOn(wa, '_importBaileys').mockResolvedValue(baileys);
        await wa.connect();
        const sock = sockets[0];
        sock.logout = jest.fn().mockRejectedValue(new Error('Connection Closed'));
        await wa.disconnect(true);
        expect(sock.end).toHaveBeenCalled();
        expect(wa.sock).toBeNull();
    });

    test('a socket the service let go of does not write the login', async () => {
        const saves = [];
        const useMultiFileAuthState = jest.fn(async () => { const saveCreds = jest.fn(); saves.push(saveCreds); return { state: {}, saveCreds }; });
        const { baileys, sockets } = fakeBaileys({ useMultiFileAuthState });
        jest.spyOn(wa, '_importBaileys').mockResolvedValue(baileys);
        await wa.connect();
        expect(await until(() => sockets.length >= 2)).toBe(true);
        sockets[0].ev.emit('creds.update', { me: { id: 'x' } });
        expect(saves[0]).not.toHaveBeenCalled();
        sockets[1].ev.emit('creds.update', { me: { id: 'x' } });
        expect(saves[1]).toHaveBeenCalledTimes(1);
    });

    test('WHATSAPP_CONNECT_WATCHDOG=0 turns the watchdog off', async () => {
        process.env.WHATSAPP_CONNECT_WATCHDOG = '0';
        const { baileys, sockets } = fakeBaileys();
        jest.spyOn(wa, '_importBaileys').mockResolvedValue(baileys);
        await wa.connect();
        expect(wa.connectWatchdog).toBeNull();
        await new Promise(r => setTimeout(r, 80));
        expect(sockets).toHaveLength(1);
        expect(wa.status).toBe('connecting');
    });

    test('a connect that throws tries again with the backoff when the session is paired', async () => {
        paired(wa);
        const useMultiFileAuthState = jest.fn()
            .mockRejectedValueOnce(new Error('EIO: i/o error'))
            .mockResolvedValue({ state: {}, saveCreds: jest.fn() });
        const { baileys, sockets } = fakeBaileys({ useMultiFileAuthState });
        jest.spyOn(wa, '_importBaileys').mockResolvedValue(baileys);

        await wa.connect();
        expect(wa.status).toBe('disconnected');
        expect(wa.reconnectTimeout).not.toBeNull();
        expect(await until(() => sockets.length === 1)).toBe(true);
    });

    describe('telling the owner', () => {
        const alerts = () => axios.post.mock.calls.map(c => c[1]?.metadata?.alertKey).filter(Boolean);

        beforeEach(() => {
            wa.downAlertMs = 60;
            // These tests are about the alert; the try just hangs.
            process.env.WHATSAPP_CONNECT_WATCHDOG = '0';
        });

        test('a paired session down too long tells him once, and again when it is back', async () => {
            paired(wa);
            const { baileys, sockets } = fakeBaileys();
            jest.spyOn(wa, '_importBaileys').mockResolvedValue(baileys);

            await wa.start();
            expect(await until(() => alerts().length === 1)).toBe(true);
            expect(alerts()).toEqual([`whatsapp_down:${wa.sessionId}`]);
            expect(axios.post.mock.calls[0][1]).toMatchObject({
                source: 'system',
                content: expect.stringMatching(new RegExp(`"${wa.sessionId}" has not been connected for \\d+ minutes \\(status: connecting\\)`)),
                metadata: { internal_system_alert: true },
            });

            // Still down: no second alert.
            await new Promise(r => setTimeout(r, 120));
            expect(alerts()).toHaveLength(1);

            sockets[0].ev.emit('connection.update', { connection: 'open' });
            expect(await until(() => alerts().length === 2)).toBe(true);
            expect(alerts()[1]).toBe(`whatsapp_up:${wa.sessionId}`);
        });

        test('a session that opens in time sends nothing', async () => {
            paired(wa);
            const { baileys, sockets } = fakeBaileys();
            jest.spyOn(wa, '_importBaileys').mockResolvedValue(baileys);
            await wa.start();
            sockets[0].ev.emit('connection.update', { connection: 'open' });
            await new Promise(r => setTimeout(r, 120));
            expect(alerts()).toEqual([]);
        });

        test('no login on disk, or WHATSAPP_DOWN_ALERT=0: no alert', async () => {
            const { baileys } = fakeBaileys();
            jest.spyOn(wa, '_importBaileys').mockResolvedValue(baileys);
            await wa.connect();
            wa._armDownAlert();
            await new Promise(r => setTimeout(r, 120));
            expect(alerts()).toEqual([]);

            paired(wa);
            process.env.WHATSAPP_DOWN_ALERT = '0';
            wa._armDownAlert();
            await new Promise(r => setTimeout(r, 120));
            expect(alerts()).toEqual([]);
        });

        test('a connected session that drops and stays down is reported', async () => {
            // The incident: a session that was up, closed, and never came back.
            paired(wa);
            const { baileys, sockets } = fakeBaileys();
            jest.spyOn(wa, '_importBaileys').mockResolvedValue(baileys);
            await wa.connect();
            sockets[0].ev.emit('connection.update', { connection: 'open' });
            expect(await until(() => wa.status === 'connected')).toBe(true);
            expect(wa.downAlertTimer).toBeNull();

            sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
            expect(await until(() => alerts().length === 1, 1000)).toBe(true);
            expect(alerts()).toEqual([`whatsapp_down:${wa.sessionId}`]);
        });

        test.each(['needs_repair', 'scan_qr'])('a session in %s gets no down alert', async (status) => {
            // needs_repair sent its own alert; scan_qr means someone is pairing.
            paired(wa);
            wa.status = status;
            await wa._onDownTooLong();
            expect(alerts()).toEqual([]);
            expect(wa.downAlertSent).toBe(false);
        });

        test('a down alert the agent did not take is tried again, and only then counts as sent', async () => {
            paired(wa);
            axios.post.mockRejectedValueOnce(new Error('ECONNREFUSED'));
            const { baileys } = fakeBaileys();
            jest.spyOn(wa, '_importBaileys').mockResolvedValue(baileys);
            await wa.connect();
            expect(await until(() => axios.post.mock.calls.length === 1)).toBe(true);
            expect(wa.downAlertSent).toBe(false);
            expect(await until(() => axios.post.mock.calls.length === 2)).toBe(true);
            expect(await until(() => wa.downAlertSent === true)).toBe(true);
        });

        test('WHATSAPP_DOWN_ALERT=0 also silences the logout and "back" alerts', async () => {
            paired(wa);
            process.env.WHATSAPP_DOWN_ALERT = '0';
            const { baileys, sockets } = fakeBaileys();
            jest.spyOn(wa, '_importBaileys').mockResolvedValue(baileys);
            await wa.connect();
            wa.downAlertSent = true;
            sockets[0].ev.emit('connection.update', { connection: 'open' });
            sockets[0].logout = jest.fn().mockResolvedValue(undefined);
            sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
            expect(await until(() => !fs.existsSync(wa.authFolder))).toBe(true);
            expect(alerts()).toEqual([]);
        });

        test('a QR nobody scanned is not reported as down, even with routing info on disk', async () => {
            // Baileys may save creds.json (routing info) before the QR is scanned.
            fs.writeFileSync(path.join(wa.authFolder, 'creds.json'), JSON.stringify({ routingInfo: 'x' }));
            const { baileys, sockets } = fakeBaileys();
            jest.spyOn(wa, '_importBaileys').mockResolvedValue(baileys);
            await wa.start();
            sockets[0].ev.emit('connection.update', { qr: 'qr-ref' });
            expect(await until(() => wa.status === 'scan_qr')).toBe(true);
            sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
            expect(wa.status).toBe('disconnected');
            await new Promise(r => setTimeout(r, 120));
            expect(alerts()).toEqual([]);
        });

        test('a logout by WhatsApp tells him at once and still wipes the login', async () => {
            paired(wa);
            const { baileys, sockets } = fakeBaileys();
            sockets.length = 0;
            jest.spyOn(wa, '_importBaileys').mockResolvedValue(baileys);
            await wa.connect();
            sockets[0].logout = jest.fn().mockResolvedValue(undefined);
            sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
            expect(await until(() => !fs.existsSync(wa.authFolder))).toBe(true);
            expect(alerts()).toEqual([`whatsapp_logged_out:${wa.sessionId}`]);
            // The wipe clears the down timer: nothing more follows.
            expect(wa.downAlertTimer).toBeNull();
            await new Promise(r => setTimeout(r, 120));
            expect(alerts()).toHaveLength(1);
        });
    });
});
