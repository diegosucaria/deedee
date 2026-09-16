#!/usr/bin/env node
/**
 * Smoke test for the browser MCP server (@playwright/mcp on system Chromium).
 *
 * Spawns the server with the exact args from mcp_config.json (a temp
 * DATA_DIR), then checks the four things Deedee relies on:
 * 1. browser_navigate to a data: URL returns a snapshot with the page text.
 * 2. browser_take_screenshot returns an image content item.
 * 3. Chromium answers on the CDP port while the server holds its pipe.
 * 4. The server closes cleanly.
 *
 * The smoke uses its own CDP port (SMOKE_CDP_PORT, default 9333) through a
 * temp copy of playwright-mcp.config.json, so it runs beside the agent's
 * live browser server (which owns 9222) without a false "port busy" FAIL.
 *
 * Env: BROWSER_EXECUTABLE_PATH (default /usr/bin/chromium-browser).
 * Runs in CI (browser-smoke job) from the repo root:
 *   node apps/agent/scripts/browser-smoke.js
 * and inside the agent container on the Pi, whose WORKDIR is /app/apps/agent:
 *   node scripts/browser-smoke.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { debugPortFromConfig } = require('../src/utils/browser-profile');

const AGENT_DIR = path.resolve(__dirname, '..');
const MARKER = `deedee-smoke-${Date.now()}`;
const SMOKE_CDP_PORT = parseInt(process.env.SMOKE_CDP_PORT || '9333', 10);

/**
 * Copies the Playwright config into `dir` with the CDP port swapped for
 * `port`. Returns the copy's path.
 */
function writeSmokeConfig(sourcePath, dir, port) {
    const cfg = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    const launch = cfg.browser = cfg.browser || {};
    launch.launchOptions = launch.launchOptions || {};
    const args = (launch.launchOptions.args || []).filter(a => !String(a).startsWith('--remote-debugging-port='));
    args.push(`--remote-debugging-port=${port}`);
    launch.launchOptions.args = args;
    const out = path.join(dir, 'playwright-mcp.config.json');
    fs.writeFileSync(out, JSON.stringify(cfg, null, 2));
    return out;
}

/** Replaces the value after `--config` in `args` (or appends the flag). */
function withConfig(args, configPath) {
    const i = args.indexOf('--config');
    if (i >= 0 && i + 1 < args.length) return [...args.slice(0, i + 1), configPath, ...args.slice(i + 2)];
    return [...args, '--config', configPath];
}

function log(msg) { console.log(`[browser-smoke] ${msg}`); }
function fail(msg) { console.error(`[browser-smoke] FAIL: ${msg}`); process.exit(1); }

function textOf(result) {
    return (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
}

async function main() {
    const executable = process.env.BROWSER_EXECUTABLE_PATH || '/usr/bin/chromium-browser';
    if (!fs.existsSync(executable)) fail(`browser executable not found: ${executable}`);
    try {
        log(`browser: ${execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim()}`);
    } catch (e) {
        log(`could not read browser version: ${e.message}`);
    }

    const config = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, 'mcp_config.json'), 'utf8'));
    const entry = config.browser;
    if (!entry) fail('mcp_config.json has no browser entry');

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-browser-smoke-'));
    const vars = { DATA_DIR: dataDir, BROWSER_EXECUTABLE_PATH: executable };
    const resolve = (s) => String(s).replace(/\$\{([^}]+)\}/g, (_, k) => vars[k] ?? process.env[k] ?? '');
    const smokeConfig = writeSmokeConfig(path.join(AGENT_DIR, 'playwright-mcp.config.json'), dataDir, SMOKE_CDP_PORT);
    const args = withConfig(entry.args.map(resolve), smokeConfig);
    const env = { ...process.env };
    for (const [k, v] of Object.entries(entry.env || {})) env[k] = resolve(v);
    const port = debugPortFromConfig(smokeConfig);
    if (port !== SMOKE_CDP_PORT) fail(`smoke config port is ${port}, expected ${SMOKE_CDP_PORT}`);

    log(`spawning: node ${args.join(' ')}`);
    log(`cwd: ${AGENT_DIR}, DATA_DIR: ${dataDir}, CDP port: ${port}`);

    const transport = new StdioClientTransport({
        command: process.execPath,
        args,
        env,
        cwd: AGENT_DIR,
        stderr: 'pipe',
    });
    transport.stderr?.on('data', d => process.stderr.write(`[server] ${d}`));

    const client = new Client({ name: 'deedee-browser-smoke', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    log(`server up, ${names.length} tools`);
    for (const need of ['browser_navigate', 'browser_snapshot', 'browser_take_screenshot', 'browser_tabs']) {
        if (!names.includes(need)) fail(`tool missing: ${need}`);
    }

    const html = `<html><head><title>${MARKER}</title></head><body><h1>${MARKER}</h1><button>Press me</button></body></html>`;
    const url = `data:text/html,${encodeURIComponent(html)}`;
    const nav = await client.callTool({ name: 'browser_navigate', arguments: { url } }, undefined, { timeout: 120000 });
    const navText = textOf(nav);
    if (nav.isError) fail(`browser_navigate returned an error:\n${navText}`);
    if (!navText.includes(MARKER)) fail(`snapshot after navigate lacks the marker:\n${navText.slice(0, 1500)}`);
    log('navigate + snapshot ok');

    const snap = await client.callTool({ name: 'browser_snapshot', arguments: {} }, undefined, { timeout: 60000 });
    if (!textOf(snap).includes('Press me')) fail('browser_snapshot lacks the button text');
    log('snapshot ok');

    const shot = await client.callTool({ name: 'browser_take_screenshot', arguments: { type: 'jpeg' } }, undefined, { timeout: 60000 });
    const image = (shot.content || []).find(c => c.type === 'image');
    if (!image) fail(`browser_take_screenshot returned no image item: ${JSON.stringify(shot).slice(0, 500)}`);
    if (!image.data || image.data.length < 100) fail('screenshot image is empty');
    log(`screenshot ok (${image.mimeType}, ${image.data.length} base64 chars)`);

    const res = await fetch(`http://127.0.0.1:${port}/json/version`).catch(e => fail(`CDP port ${port} not answering: ${e.message}`));
    if (!res.ok) fail(`CDP /json/version status ${res.status}`);
    const version = await res.json();
    if (!version.webSocketDebuggerUrl) fail(`CDP /json/version lacks webSocketDebuggerUrl: ${JSON.stringify(version)}`);
    log(`CDP ok: ${version.Browser}`);

    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    if (!Array.isArray(list) || !list.some(t => t.type === 'page')) fail('CDP /json/list has no page target');
    log(`CDP lists ${list.length} target(s)`);

    await client.close();
    log('closed');
    fs.rmSync(dataDir, { recursive: true, force: true });
    log('PASS');
    process.exit(0);
}

main().catch(e => fail(e.stack || e.message));
