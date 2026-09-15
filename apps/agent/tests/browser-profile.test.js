const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { argValue, lockPid, clearStaleProfileLock, isPortBusy, waitForPortFree, debugPortFromConfig, LOCK_FILES } = require('../src/utils/browser-profile');

function makeProfile(pid) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-profile-'));
    fs.symlinkSync(`somehost-${pid}`, path.join(dir, 'SingletonLock'));
    fs.symlinkSync(`somehost-${pid}`, path.join(dir, 'SingletonSocket'));
    fs.writeFileSync(path.join(dir, 'SingletonCookie'), 'x');
    fs.writeFileSync(path.join(dir, 'Preferences'), '{}');
    return dir;
}

describe('browser-profile argValue', () => {
    test('reads "--flag value" and "--flag=value"', () => {
        expect(argValue(['--user-data-dir', '/x'], '--user-data-dir')).toBe('/x');
        expect(argValue(['--user-data-dir=/y'], '--user-data-dir')).toBe('/y');
        expect(argValue(['--other', 'a'], '--user-data-dir')).toBeNull();
    });
});

describe('clearStaleProfileLock', () => {
    test('no lock file: nothing to do', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-profile-'));
        expect(clearStaleProfileLock(dir)).toEqual({ cleared: false, reason: 'no-lock' });
    });

    test('keeps the lock when the pid is a live chromium', () => {
        const dir = makeProfile(4242);
        const r = clearStaleProfileLock(dir, { isAlive: () => true, isChromium: () => true });
        expect(r).toEqual({ cleared: false, reason: 'live', pid: 4242 });
        expect(fs.existsSync(path.join(dir, 'SingletonCookie'))).toBe(true);
    });

    test('removes all three files when the pid is dead', () => {
        const dir = makeProfile(4243);
        const r = clearStaleProfileLock(dir, { isAlive: () => false, isChromium: () => true });
        expect(r).toEqual({ cleared: true, reason: 'dead-pid', pid: 4243 });
        for (const f of LOCK_FILES) expect(fs.existsSync(path.join(dir, f))).toBe(false);
        expect(fs.existsSync(path.join(dir, 'Preferences'))).toBe(true);
    });

    test('removes the lock when the live pid is not chromium (pid reuse)', () => {
        const dir = makeProfile(process.pid);
        expect(lockPid(dir)).toBe(process.pid);
        // Real isAlive: this test process is alive but is node, not chromium.
        const r = clearStaleProfileLock(dir);
        expect(r.cleared).toBe(true);
        expect(r.reason).toBe('not-chromium');
    });

    test('removes a lock whose target has no pid', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-profile-'));
        fs.symlinkSync('garbage', path.join(dir, 'SingletonLock'));
        expect(clearStaleProfileLock(dir).reason).toBe('bad-lock');
        expect(fs.existsSync(path.join(dir, 'SingletonLock'))).toBe(false);
    });
});

describe('isPortBusy', () => {
    test('true while a server listens, false after it closes', async () => {
        const server = net.createServer();
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        const { port } = server.address();
        expect(await isPortBusy(port)).toBe(true);
        await new Promise(r => server.close(r));
        expect(await isPortBusy(port)).toBe(false);
    });
});

describe('waitForPortFree', () => {
    test('resolves true once the listener closes, and reports the wait', async () => {
        const server = net.createServer();
        await new Promise(res => server.listen(0, '127.0.0.1', res));
        const port = server.address().port;
        const onWait = jest.fn();
        setTimeout(() => server.close(), 300);
        const t0 = Date.now();
        expect(await waitForPortFree(port, { timeoutMs: 5000, intervalMs: 50, onWait })).toBe(true);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
        expect(onWait).toHaveBeenCalledTimes(1);
    });

    test('resolves false when the port stays busy past the timeout', async () => {
        const server = net.createServer();
        await new Promise(res => server.listen(0, '127.0.0.1', res));
        const port = server.address().port;
        expect(await waitForPortFree(port, { timeoutMs: 300, intervalMs: 50 })).toBe(false);
        await new Promise(res => server.close(res));
    });

    test('resolves true at once for a free port', async () => {
        const server = net.createServer();
        await new Promise(res => server.listen(0, '127.0.0.1', res));
        const port = server.address().port;
        await new Promise(res => server.close(res));
        const onWait = jest.fn();
        expect(await waitForPortFree(port, { timeoutMs: 1000, onWait })).toBe(true);
        expect(onWait).not.toHaveBeenCalled();
    });
});

describe('debugPortFromConfig', () => {
    test('reads the port from the repo config and falls back to 9222', () => {
        const repoConfig = path.join(__dirname, '..', 'playwright-mcp.config.json');
        expect(debugPortFromConfig(repoConfig)).toBe(9222);
        expect(debugPortFromConfig('/nonexistent.json')).toBe(9222);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-profile-'));
        const p = path.join(dir, 'c.json');
        fs.writeFileSync(p, JSON.stringify({ browser: { launchOptions: { args: ['--remote-debugging-port=9333'] } } }));
        expect(debugPortFromConfig(p)).toBe(9333);
    });
});
