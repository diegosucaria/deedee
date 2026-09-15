/**
 * Helpers for the browser MCP launcher (scripts/browser-mcp.js).
 *
 * Chromium leaves SingletonLock/SingletonSocket/SingletonCookie in the profile
 * after a hard kill. playwright-mcp checks the lock with process.kill(pid, 0),
 * so a reused pid gives a false "already in use". We only remove the lock when
 * the pid is dead or belongs to another program.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');

const LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
const DEFAULT_DEBUG_PORT = 9222;

/** Value of `--flag value` or `--flag=value` in argv, or null. */
function argValue(argv, flag) {
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === flag) return argv[i + 1] ?? null;
        if (argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1);
    }
    return null;
}

/** Pid recorded in the SingletonLock symlink (`host-pid`), or null. */
function lockPid(userDataDir) {
    let target;
    try {
        target = fs.readlinkSync(path.join(userDataDir, 'SingletonLock'));
    } catch {
        return null;
    }
    const pid = parseInt(target.split('-').pop() || '', 10);
    return Number.isNaN(pid) ? NaN : pid;
}

function defaultIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

function defaultIsChromium(pid, procRoot = '/proc') {
    try {
        const cmdline = fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf8');
        return /chrom/i.test(cmdline.split('\0')[0] || '');
    } catch {
        return false;
    }
}

/**
 * Removes stale Chromium singleton files from `userDataDir`.
 * Returns { cleared, reason }. `reason` is one of:
 * 'no-lock' | 'live' | 'dead-pid' | 'not-chromium' | 'bad-lock'.
 */
function clearStaleProfileLock(userDataDir, { isAlive = defaultIsAlive, isChromium = defaultIsChromium } = {}) {
    const pid = lockPid(userDataDir);
    if (pid === null) return { cleared: false, reason: 'no-lock' };

    let reason;
    if (Number.isNaN(pid)) reason = 'bad-lock';
    else if (!isAlive(pid)) reason = 'dead-pid';
    else if (!isChromium(pid)) reason = 'not-chromium';
    else return { cleared: false, reason: 'live', pid };

    for (const name of LOCK_FILES) {
        try { fs.unlinkSync(path.join(userDataDir, name)); } catch { /* already gone */ }
    }
    return { cleared: true, reason, pid };
}

/** Resolves true when something accepts TCP connections on host:port. */
function isPortBusy(port, host = '127.0.0.1', timeoutMs = 500) {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host });
        const done = (busy) => { socket.destroy(); resolve(busy); };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

/** Port from `--remote-debugging-port=N` in the Playwright config's launch args. */
function debugPortFromConfig(configPath) {
    try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const args = cfg?.browser?.launchOptions?.args || [];
        const hit = args.find(a => typeof a === 'string' && a.startsWith('--remote-debugging-port='));
        const port = hit ? parseInt(hit.split('=')[1], 10) : NaN;
        return Number.isNaN(port) ? DEFAULT_DEBUG_PORT : port;
    } catch {
        return DEFAULT_DEBUG_PORT;
    }
}

module.exports = { argValue, lockPid, clearStaleProfileLock, isPortBusy, debugPortFromConfig, LOCK_FILES, DEFAULT_DEBUG_PORT };
