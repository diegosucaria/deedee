#!/usr/bin/env node
/**
 * Launcher for the browser MCP server (@playwright/mcp).
 *
 * Runs before every spawn, including restartServer:
 * 1. Clears a stale Chromium profile lock (dead pid or not chromium).
 * 2. Makes sure the secrets file exists; --secrets fails on a missing file.
 * 3. Checks the CDP port. playwright would hang until its launch timeout if
 *    another Chromium already holds it, so fail fast with a clear message.
 * Then hands argv to the real CLI (cli.js in the @playwright/mcp package) unchanged.
 */
const fs = require('fs');
const path = require('path');
const { argValue, clearStaleProfileLock, isPortBusy, debugPortFromConfig } = require('../src/utils/browser-profile');

async function main() {
    const argv = process.argv.slice(2);
    const userDataDir = argValue(argv, '--user-data-dir');
    if (userDataDir) {
        fs.mkdirSync(userDataDir, { recursive: true });
        const r = clearStaleProfileLock(userDataDir);
        if (r.cleared) console.error(`[browser-mcp] removed stale profile lock (${r.reason}, pid ${r.pid})`);
    }

    const secretsFile = argValue(argv, '--secrets');
    if (secretsFile && !fs.existsSync(secretsFile)) {
        fs.mkdirSync(path.dirname(secretsFile), { recursive: true });
        fs.writeFileSync(secretsFile, '', { mode: 0o600 });
    }

    const outputDir = argValue(argv, '--output-dir');
    if (outputDir) fs.mkdirSync(outputDir, { recursive: true });

    const configFile = argValue(argv, '--config');
    const port = debugPortFromConfig(configFile ? path.resolve(configFile) : '');
    if (await isPortBusy(port)) {
        console.error(`[browser-mcp] port 127.0.0.1:${port} is busy. Another Chromium (or an old browser MCP) still holds it. Stop it, then reload the MCP servers.`);
        process.exit(1);
    }

    // The package's "exports" map hides cli.js, so resolve it by path.
    const pkgDir = path.dirname(require.resolve('@playwright/mcp/package.json'));
    require(path.join(pkgDir, 'cli.js'));
}

main().catch((e) => {
    console.error(`[browser-mcp] launcher failed: ${e.message}`);
    process.exit(1);
});
