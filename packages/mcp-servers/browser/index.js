#!/usr/bin/env node

/**
 * MCP Server — Browser V2 (Playwright)
 * ARIA Snapshot + Ref-Based Interactions.
 *
 * Replaces CSS selectors with semantic refs (e1, e2, ...) resolved via getByRole().
 * See specs/041-agentic-browser-v2.md for design rationale.
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
    ListToolsRequestSchema,
    CallToolRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const { execSync } = require('child_process');

// V2 Modules
const { getPageSnapshot } = require('./src/snapshot.js');
const {
    handleClick, handleType, handleFillForm, handleSelect,
    handleHover, handleScroll, handlePressKey, handleDrag
} = require('./src/interactions.js');
const { clearRefs, refLocator } = require('./src/state.js');
const { handleWait } = require('./src/wait');
const { screenshotWithLabels } = require('./src/vision');
const { initScreencast } = require('./src/screencast');

// Config
const HEADLESS = process.env.BROWSER_HEADLESS !== 'false';
const USER_DATA_DIR = process.env.BROWSER_USER_DATA_DIR || path.join(process.cwd(), 'browser-profile');
const EXECUTABLE_PATH = process.env.BROWSER_EXECUTABLE_PATH || undefined;

// Globals
let browser = null;
let page = null;

const server = new Server(
    { name: "deedee-browser-server", version: "2.0.0" },
    { capabilities: { tools: {} } }
);

// --- Profile Lock Cleanup ---

function cleanProfile() {
    try {
        const lockFile = path.join(USER_DATA_DIR, 'SingletonLock');
        if (fs.existsSync(lockFile)) {
            fs.unlinkSync(lockFile);
            console.log('[Browser] Removed stale SingletonLock');
        }
    } catch (e) {
        console.warn('[Browser] Lock cleanup warning:', e.message);
    }
}

function nukeProfileLocks() {
    try {
        const lockPatterns = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
        for (const pattern of lockPatterns) {
            const lockPath = path.join(USER_DATA_DIR, pattern);
            if (fs.existsSync(lockPath)) {
                try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
            }
        }
        // Kill orphaned chromium processes
        try {
            if (process.platform !== 'win32') {
                execSync('pkill -f "chromium.*--user-data-dir" 2>/dev/null || true', { timeout: 3000 });
            }
        } catch { /* ignore */ }
    } catch (e) {
        console.warn('[Browser] Nuke locks warning:', e.message);
    }
}

// --- Browser Lifecycle ---

async function ensureBrowser() {
    if (page) {
        if (!page.isClosed()) return page;
        console.warn('[Browser] Page was closed. Re-initializing...');
        page = null;
        if (browser) await browser.close().catch(() => { });
        browser = null;
    }

    console.error(`[Browser] Launching browser... (Headless: ${HEADLESS}, Profile: ${USER_DATA_DIR}, Exec: ${EXECUTABLE_PATH || 'Bundled'})`);

    if (!fs.existsSync(USER_DATA_DIR)) {
        fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    } else {
        cleanProfile();
        nukeProfileLocks();
    }

    const launchOptions = {
        headless: HEADLESS,
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        ignoreDefaultArgs: ['--enable-automation'],
    };

    if (EXECUTABLE_PATH) launchOptions.executablePath = EXECUTABLE_PATH;

    try {
        browser = await chromium.launchPersistentContext(USER_DATA_DIR, launchOptions);
    } catch (launchErr) {
        console.error('[Browser] First launch failed. Retrying...', launchErr.message);
        nukeProfileLocks();
        await new Promise(r => setTimeout(r, 2000));
        try {
            browser = await chromium.launchPersistentContext(USER_DATA_DIR, launchOptions);
        } catch (retryErr) {
            console.error('[Browser] FATAL: Retry launch failed:', retryErr);
            throw retryErr;
        }
    }

    const pages = browser.pages();
    page = pages.length > 0 ? pages[0] : await browser.newPage();

    // Initialize CDP screencast
    await initScreencast(browser, page);

    return page;
}

// --- Secrets ---

const SECRETS_FILE = path.join(USER_DATA_DIR, 'browser-secrets.json');

function loadSecrets() {
    try {
        if (fs.existsSync(SECRETS_FILE)) {
            return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf-8'));
        }
    } catch (e) {
        console.error('[Browser] Error loading secrets:', e.message);
    }
    return {};
}

// --- Tool Definitions ---

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            // Navigation
            {
                name: "browser_navigate",
                description: "Navigate the browser to a URL. Returns page title and a compact ARIA snapshot with refs.",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: { type: "string", description: "URL to navigate to" },
                        waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle", "commit"], description: "When to consider navigation done (default: domcontentloaded)" },
                    },
                    required: ["url"],
                },
            },
            {
                name: "browser_snapshot",
                description: "Get the page's ARIA accessibility tree with refs (e1, e2, ...). Use these refs for click, type, fill, select. This is the PRIMARY tool for understanding page structure.",
                inputSchema: {
                    type: "object",
                    properties: {
                        interactiveOnly: { type: "boolean", description: "Only show interactive elements (buttons, inputs, links). Default: false" },
                        compact: { type: "boolean", description: "Prune branches without interactive elements. Default: true" },
                        frameSelector: { type: "string", description: "Optional iframe to inspect (e.g. 'iframe[title=\"Payment\"]')" },
                    },
                },
            },
            {
                name: "browser_screenshot",
                description: "Take a screenshot of the current page.",
                inputSchema: {
                    type: "object",
                    properties: {
                        fullPage: { type: "boolean", description: "Capture full scrollable page. Default: false" },
                        withLabels: { type: "boolean", description: "Overlay ref labels on interactive elements. Default: false" },
                    },
                },
            },
            {
                name: "browser_extract_text",
                description: "Extract the visible text content of the page as markdown.",
                inputSchema: { type: "object", properties: {} },
            },

            // Interaction (Ref-Based)
            {
                name: "browser_click",
                description: "Click an element by its ref (e.g. ref='e1'). Get refs from browser_snapshot first.",
                inputSchema: {
                    type: "object",
                    properties: {
                        ref: { type: "string", description: "Element ref from snapshot (e.g. 'e1', 'e2')" },
                        doubleClick: { type: "boolean", description: "Double-click instead of single click" },
                        button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button. Default: left" },
                        frameSelector: { type: "string", description: "Optional iframe selector" },
                        timeoutMs: { type: "number", description: "Max time to wait in ms (500-60000)" },
                    },
                    required: ["ref"],
                },
            },
            {
                name: "browser_type",
                description: "Type text into an element by ref. Uses fill() by default (fast, replaces content). Use 'slowly' for character-by-character typing. Use 'submit' to press Enter after.",
                inputSchema: {
                    type: "object",
                    properties: {
                        ref: { type: "string", description: "Element ref from snapshot" },
                        text: { type: "string", description: "Text to type" },
                        submit: { type: "boolean", description: "Press Enter after typing" },
                        slowly: { type: "boolean", description: "Type character by character (for autocomplete fields)" },
                        frameSelector: { type: "string", description: "Optional iframe selector" },
                        timeoutMs: { type: "number", description: "Max time to wait in ms" },
                    },
                    required: ["ref", "text"],
                },
            },
            {
                name: "browser_fill_form",
                description: "Fill multiple form fields at once. Much faster than typing one at a time.",
                inputSchema: {
                    type: "object",
                    properties: {
                        fields: {
                            type: "array",
                            description: "Array of fields to fill",
                            items: {
                                type: "object",
                                properties: {
                                    ref: { type: "string", description: "Element ref" },
                                    value: { type: "string", description: "Value to fill" },
                                    type: { type: "string", enum: ["text", "checkbox", "radio"], description: "Field type (auto-detected if omitted)" },
                                },
                                required: ["ref", "value"],
                            },
                        },
                        frameSelector: { type: "string", description: "Optional iframe selector if fields are inside an iframe" },
                        timeoutMs: { type: "number", description: "Max time to wait in ms per field" },
                    },
                    required: ["fields"],
                },
            },
            {
                name: "browser_select",
                description: "Select option(s) from a dropdown by ref.",
                inputSchema: {
                    type: "object",
                    properties: {
                        ref: { type: "string", description: "Element ref for the select/combobox" },
                        values: {
                            oneOf: [
                                { type: "string", description: "Single value to select" },
                                { type: "array", items: { type: "string" }, description: "Multiple values to select" },
                            ],
                            description: "Value(s) to select",
                        },
                        frameSelector: { type: "string", description: "Optional iframe selector" },
                        timeoutMs: { type: "number", description: "Max time to wait in ms" },
                    },
                    required: ["ref", "values"],
                },
            },
            {
                name: "browser_press_key",
                description: "Press a keyboard key (Enter, Tab, Escape, ArrowDown, etc.).",
                inputSchema: {
                    type: "object",
                    properties: {
                        key: { type: "string", description: "Key to press (e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown')" },
                        timeoutMs: { type: "number", description: "Max time to wait in ms" },
                    },
                    required: ["key"],
                },
            },
            {
                name: "browser_hover",
                description: "Hover over an element by ref. Useful for revealing tooltips or dropdown menus.",
                inputSchema: {
                    type: "object",
                    properties: {
                        ref: { type: "string", description: "Element ref to hover" },
                        frameSelector: { type: "string", description: "Optional iframe selector" },
                        timeoutMs: { type: "number", description: "Max time to wait in ms" },
                    },
                    required: ["ref"],
                },
            },
            {
                name: "browser_drag",
                description: "Drag an element to another element by refs.",
                inputSchema: {
                    type: "object",
                    properties: {
                        startRef: { type: "string", description: "Ref of the element to drag (e.g. 'e1')" },
                        endRef: { type: "string", description: "Ref of the destination element (e.g. 'e2')" },
                        frameSelector: { type: "string", description: "Optional iframe selector" },
                        timeoutMs: { type: "number", description: "Max time to wait in ms" },
                    },
                    required: ["startRef", "endRef"],
                },
            },
            {
                name: "browser_scroll",
                description: "Scroll to an element (by ref) or scroll the page in a direction.",
                inputSchema: {
                    type: "object",
                    properties: {
                        ref: { type: "string", description: "Element ref to scroll into view (optional)" },
                        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction if no ref (default: down)" },
                        frameSelector: { type: "string", description: "Optional iframe selector" },
                        timeoutMs: { type: "number", description: "Max time to wait in ms" },
                    },
                },
            },

            // Waiting
            {
                name: "browser_wait",
                description: "Wait for a condition before proceeding. Use after actions that trigger page changes.",
                inputSchema: {
                    type: "object",
                    properties: {
                        text: { type: "string", description: "Wait for this text to appear on page" },
                        textGone: { type: "string", description: "Wait for this text to disappear" },
                        url: { type: "string", description: "Wait for URL to match (supports glob patterns)" },
                        loadState: { type: "string", enum: ["load", "domcontentloaded", "networkidle"], description: "Wait for load state" },
                        timeMs: { type: "number", description: "Wait for a fixed time in milliseconds (max 10000)" },
                        timeout: { type: "number", description: "Maximum wait time in ms (default: 30000, max: 60000)" },
                    },
                },
            },

            // Advanced
            {
                name: "browser_evaluate",
                description: "Run JavaScript code on the page. Return value will be captured.",
                inputSchema: {
                    type: "object",
                    properties: {
                        script: { type: "string", description: "JavaScript code to run. Return value will be captured." },
                    },
                    required: ["script"],
                },
            },
            {
                name: "browser_fill_secret",
                description: "Securely type a secret value into a field by ref. Use browser_list_secrets to see available keys.",
                inputSchema: {
                    type: "object",
                    properties: {
                        ref: { type: "string", description: "Element ref for the field" },
                        secretKey: { type: "string", description: "Secret key name" },
                    },
                    required: ["ref", "secretKey"],
                },
            },
            {
                name: "browser_list_secrets",
                description: "List available secret keys that can be used with browser_fill_secret.",
                inputSchema: { type: "object", properties: {} },
            },
        ],
    };
});

// --- Tool Handlers ---

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        const requiresBrowser = name !== "browser_list_secrets";
        let p = null;

        if (requiresBrowser) {
            p = await ensureBrowser();
        }

        // --- Navigation ---

        if (name === "browser_navigate") {
            const waitUntil = args.waitUntil || 'domcontentloaded';
            clearRefs(); // Clear stale refs
            await p.goto(args.url, { waitUntil, timeout: 30000 });

            // Auto-snapshot after navigate (saves a round-trip)
            const { snapshot, refs, title } = await getPageSnapshot(p, { compact: true });
            const refCount = Object.keys(refs).length;

            return {
                content: [{
                    type: "text",
                    text: `Navigated to: ${title} (${args.url})\n\n` +
                        `## Page Snapshot (${refCount} interactive elements)\n\n` +
                        `${snapshot}\n\n` +
                        `Use refs (e.g. browser_click ref=e1) to interact with elements.`,
                }],
            };
        }

        if (name === "browser_snapshot") {
            const { snapshot, refs, url, title } = await getPageSnapshot(p, {
                interactiveOnly: args.interactiveOnly,
                compact: args.compact,
                frameSelector: args.frameSelector,
            });
            const refCount = Object.keys(refs).length;

            return {
                content: [{
                    type: "text",
                    text: `## ${title} (${url})\n${refCount} interactive refs\n\n${snapshot}`,
                }],
            };
        }

        // --- Screenshots ---

        if (name === "browser_screenshot") {
            if (args.withLabels) {
                const { image, labelCount } = await screenshotWithLabels(p);
                return {
                    content: [
                        { type: "image", data: image.toString('base64'), mimeType: "image/png" },
                        { type: "text", text: `Screenshot with ${labelCount} labeled refs. Use these refs with browser_click, browser_type, etc.` },
                    ],
                };
            }

            const buffer = await p.screenshot({ fullPage: args.fullPage || false });
            return {
                content: [{ type: "image", data: buffer.toString('base64'), mimeType: "image/png" }],
            };
        }

        // --- Text Extraction ---

        if (name === "browser_extract_text") {
            const TurndownService = require('turndown');
            const turndown = new TurndownService({
                headingStyle: 'atx',
                codeBlockStyle: 'fenced',
            });

            const html = await p.evaluate(() => {
                // Remove non-content elements
                const clone = document.body.cloneNode(true);
                clone.querySelectorAll('script, style, noscript, svg, iframe').forEach(el => el.remove());
                return clone.innerHTML;
            });

            const markdown = turndown.turndown(html);

            // Truncate if excessively long
            const maxLen = 30000;
            const truncated = markdown.length > maxLen
                ? markdown.slice(0, maxLen) + '\n\n... (truncated)'
                : markdown;

            return { content: [{ type: "text", text: truncated }] };
        }

        // --- Ref-Based Interactions ---

        if (name === "browser_click") {
            const result = await handleClick(p, args);
            return { content: [{ type: "text", text: result.message }] };
        }

        if (name === "browser_type") {
            const result = await handleType(p, args);
            return { content: [{ type: "text", text: result.message }] };
        }

        if (name === "browser_fill_form") {
            const result = await handleFillForm(p, args);
            return {
                content: [{ type: "text", text: result.message }],
                isError: !result.success,
            };
        }

        if (name === "browser_select") {
            const result = await handleSelect(p, args);
            return { content: [{ type: "text", text: result.message }] };
        }

        if (name === "browser_hover") {
            const result = await handleHover(p, args);
            return { content: [{ type: "text", text: result.message }] };
        }

        if (name === "browser_scroll") {
            const result = await handleScroll(p, args);
            return { content: [{ type: "text", text: result.message }] };
        }

        if (name === "browser_press_key") {
            const result = await handlePressKey(p, args);
            return { content: [{ type: "text", text: result.message }] };
        }

        if (name === "browser_drag") {
            const result = await handleDrag(p, args);
            return {
                content: [{ type: "text", text: result.message }],
                isError: !result.success,
            };
        }

        // --- Wait ---

        if (name === "browser_wait") {
            const result = await handleWait(p, args);
            return { content: [{ type: "text", text: `${result.message}. Current URL: ${result.url}` }] };
        }

        // --- Advanced ---

        if (name === "browser_evaluate") {
            const result = await p.evaluate(async (scriptBody) => {
                const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
                const fn = new AsyncFunction(scriptBody);
                return await fn();
            }, args.script);

            let outputText;
            if (typeof result === "object") {
                outputText = JSON.stringify(result, null, 2);
            } else if (result !== undefined && result !== null) {
                outputText = String(result);
            } else {
                outputText = "Script executed (no return value).";
            }

            return { content: [{ type: "text", text: outputText }] };
        }

        if (name === "browser_fill_secret") {
            const fileSecrets = loadSecrets();
            let val = fileSecrets[args.secretKey] || process.env[args.secretKey];

            if (!val) {
                return { isError: true, content: [{ type: "text", text: `Secret key '${args.secretKey}' not found.` }] };
            }

            const locator = refLocator(p, args.ref);
            await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => { });
            await locator.fill(val, { timeout: 5000 });
            return { content: [{ type: "text", text: `Securely filled secret into ref=${args.ref}` }] };
        }

        if (name === "browser_list_secrets") {
            const fileSecrets = loadSecrets();
            const envSecrets = Object.keys(process.env).filter(k =>
                k.startsWith('BROWSER_SECRET_')
            );
            const allKeys = [...new Set([...Object.keys(fileSecrets), ...envSecrets])];
            return { content: [{ type: "text", text: JSON.stringify(allKeys) }] };
        }

        throw new Error(`Tool ${name} not implemented.`);
    } catch (err) {
        console.error(`[Browser] Error executing ${name}:`, err);
        return {
            isError: true,
            content: [{ type: "text", text: `Error: ${err.message}` }],
        };
    }
});

// --- Server Start ---

async function run() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Browser MCP Server V2 running on stdio");
}

run().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
