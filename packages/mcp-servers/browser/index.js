#!/usr/bin/env node

/**
 * MCP Server — Browser V2 (Playwright)
 * ARIA Snapshot + Ref-Based Interactions.
 *
 * V2.1 additions:
 * - Resource blocking (Phase 1)
 * - Console capture (Phase 2)
 * - Network monitoring (Phase 3)
 * - Auto-snapshot after interactions (Phase 4)
 * - Multi-tab support (Phase 5)
 * - Download/upload handling (Phase 6)
 * - Better text extraction with Readability (Phase 7)
 * - Cookie/storage tools (Phase 8)
 *
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
const { clearRefs, refLocator, setActiveTab, getActiveTab, clearTabRefs } = require('./src/state.js');
const { handleWait } = require('./src/wait');
const { screenshotWithLabels } = require('./src/vision');
const { initScreencast, switchScreencast } = require('./src/screencast');

// V2.1 Modules
const { installResourceBlocker, setBlockedTypes, getBlockedTypes } = require('./src/resource-blocker');
const { installConsoleCapture, getConsoleMessages, clearConsoleMessages } = require('./src/console');
const { installNetworkMonitor, getNetworkLog, getResponseBody, waitForNetworkResponse, rejectPendingWaiters, clearNetworkLog } = require('./src/network');
const { installDownloadHandler, getDownloads, getDownloadDir } = require('./src/downloads');

// Config
const HEADLESS = process.env.BROWSER_HEADLESS !== 'false';
const USER_DATA_DIR = process.env.BROWSER_USER_DATA_DIR || path.join(process.cwd(), 'browser-profile');
const EXECUTABLE_PATH = process.env.BROWSER_EXECUTABLE_PATH || undefined;

// Globals
let browser = null; // BrowserContext (persistent)

const server = new Server(
    { name: "deedee-browser-server", version: "2.1.0" },
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
        try {
            if (process.platform !== 'win32') {
                execSync('pkill -f "chromium.*--user-data-dir" 2>/dev/null || true', { timeout: 3000 });
            }
        } catch { /* ignore */ }
    } catch (e) {
        console.warn('[Browser] Nuke locks warning:', e.message);
    }
}

// --- Multi-Tab Helpers ---

/**
 * Get the active page (current tab).
 */
function getActivePage() {
    if (!browser) return null;
    const pages = browser.pages();
    const idx = getActiveTab();
    if (idx >= 0 && idx < pages.length) return pages[idx];
    // Fallback to last page
    if (pages.length > 0) {
        setActiveTab(pages.length - 1);
        return pages[pages.length - 1];
    }
    return null;
}

/**
 * Install per-page listeners (console, network) on a page.
 */
function setupPageListeners(page) {
    installConsoleCapture(page);
    installNetworkMonitor(page);
}

// --- Browser Lifecycle ---

async function ensureBrowser() {
    const activePage = getActivePage();
    if (activePage && !activePage.isClosed()) return activePage;

    if (browser) {
        // Active page closed, try another
        const pages = browser.pages();
        for (let i = 0; i < pages.length; i++) {
            if (!pages[i].isClosed()) {
                setActiveTab(i);
                return pages[i];
            }
        }
        // All pages closed, relaunch
        console.warn('[Browser] All pages closed. Re-initializing...');
        await browser.close().catch(() => { });
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

    // Install context-level features
    await installResourceBlocker(browser);
    installDownloadHandler(browser, USER_DATA_DIR);

    // Listen for new pages (popups, target="_blank")
    browser.on('page', (newPage) => {
        console.log(`[Browser] New page opened: ${newPage.url()}`);
        setupPageListeners(newPage);
    });

    const pages = browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    setActiveTab(pages.indexOf(page) >= 0 ? pages.indexOf(page) : 0);

    // Setup listeners on initial page
    setupPageListeners(page);

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

// --- Auto-Snapshot Helper ---

async function autoSnapshot(page) {
    try {
        await page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => { });
        // Efficient mode: interactive-only, depth-limited, smaller output
        // This reduces token consumption from ~15K to ~3-5K per action
        const { snapshot, refs } = await getPageSnapshot(page, {
            compact: true,
            interactiveOnly: true,
            maxDepth: 6,
            maxChars: 10000,
        });
        const refCount = Object.keys(refs).length;
        return `\n\n## Updated Snapshot (${refCount} refs)\n\n${snapshot}`;
    } catch {
        return '';
    }
}

// --- Tool Definitions ---

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            // ========== Navigation ==========
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
                        maxDepth: { type: "number", description: "Max tree depth to render. Deeper elements are summarized with ref counts. Default: unlimited" },
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
                description: "Extract the visible text content of the page as markdown. Uses readability for article pages, falls back to full page extraction.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "Optional CSS selector to extract text from a specific section" },
                    },
                },
            },

            // ========== Interaction (Ref-Based) ==========
            {
                name: "browser_click",
                description: "Click an element by its ref (e.g. ref='e1'). Get refs from browser_snapshot first. Returns updated snapshot by default.",
                inputSchema: {
                    type: "object",
                    properties: {
                        ref: { type: "string", description: "Element ref from snapshot (e.g. 'e1', 'e2')" },
                        doubleClick: { type: "boolean", description: "Double-click instead of single click" },
                        button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button. Default: left" },
                        frameSelector: { type: "string", description: "Optional iframe selector" },
                        timeoutMs: { type: "number", description: "Max time to wait in ms (500-60000)" },
                        autoSnapshot: { type: "boolean", description: "Return updated snapshot after action. Default: true" },
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
                        autoSnapshot: { type: "boolean", description: "Return updated snapshot after submit. Default: true (only when submit=true)" },
                    },
                    required: ["ref", "text"],
                },
            },
            {
                name: "browser_fill_form",
                description: "Fill multiple form fields at once. Much faster than typing one at a time. Returns updated snapshot.",
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
                        autoSnapshot: { type: "boolean", description: "Return updated snapshot after filling. Default: true" },
                    },
                    required: ["fields"],
                },
            },
            {
                name: "browser_select",
                description: "Select option(s) from a dropdown by ref. Returns updated snapshot.",
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
                        autoSnapshot: { type: "boolean", description: "Return updated snapshot after selecting. Default: true" },
                    },
                    required: ["ref", "values"],
                },
            },
            {
                name: "browser_press_key",
                description: "Press a keyboard key (Enter, Tab, Escape, ArrowDown, etc.). Returns updated snapshot.",
                inputSchema: {
                    type: "object",
                    properties: {
                        key: { type: "string", description: "Key to press (e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown')" },
                        timeoutMs: { type: "number", description: "Max time to wait in ms" },
                        autoSnapshot: { type: "boolean", description: "Return updated snapshot after key press. Default: true" },
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

            // ========== Waiting ==========
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
                        networkUrl: { type: "string", description: "Wait for a network response matching this URL substring (e.g. '/api/flights')" },
                        timeMs: { type: "number", description: "Wait for a fixed time in milliseconds (max 10000)" },
                        timeout: { type: "number", description: "Maximum wait time in ms (default: 30000, max: 60000)" },
                    },
                },
            },

            // ========== Network & Console (NEW) ==========
            {
                name: "browser_network_log",
                description: "Get recent network requests/responses. Useful for seeing API calls, AJAX responses, and debugging failed requests.",
                inputSchema: {
                    type: "object",
                    properties: {
                        urlFilter: { type: "string", description: "Only show requests whose URL contains this string (e.g. '/api/', 'flights')" },
                        resourceType: { type: "string", description: "Filter by resource type: xhr, fetch, document, stylesheet, image, etc." },
                        limit: { type: "number", description: "Max entries to return (default: 30)" },
                        clear: { type: "boolean", description: "Clear the log after returning. Default: false" },
                    },
                },
            },
            {
                name: "browser_wait_for_response",
                description: "Wait for a specific network response by URL pattern. Returns the response status and body. Critical for SPAs where you need to wait for an API call to complete.",
                inputSchema: {
                    type: "object",
                    properties: {
                        urlPattern: { type: "string", description: "URL substring to match (e.g. '/api/search', 'pricing')" },
                        timeout: { type: "number", description: "Max wait time in ms (default: 30000)" },
                    },
                    required: ["urlPattern"],
                },
            },
            {
                name: "browser_get_response_body",
                description: "Get the body of the most recent network response matching a URL pattern. Useful for reading API response data (e.g. flight prices JSON).",
                inputSchema: {
                    type: "object",
                    properties: {
                        urlPattern: { type: "string", description: "URL substring to match" },
                    },
                    required: ["urlPattern"],
                },
            },
            {
                name: "browser_console_messages",
                description: "Get browser console messages (log, warn, error) and page errors. Useful for debugging when something isn't working.",
                inputSchema: {
                    type: "object",
                    properties: {
                        level: { type: "string", enum: ["log", "warn", "error", "info", "debug"], description: "Filter by level" },
                        clear: { type: "boolean", description: "Clear messages after returning. Default: false" },
                    },
                },
            },

            // ========== Resource Blocking (NEW) ==========
            {
                name: "browser_set_resource_blocking",
                description: "Control which resource types are blocked for faster page loads. Default: images, fonts, media are blocked. Use 'none' to disable blocking.",
                inputSchema: {
                    type: "object",
                    properties: {
                        blocked: {
                            type: "array",
                            items: { type: "string" },
                            description: "Resource types to block: 'image', 'font', 'media', 'stylesheet'. Use ['none'] to disable all blocking.",
                        },
                    },
                    required: ["blocked"],
                },
            },

            // ========== Multi-Tab (NEW) ==========
            {
                name: "browser_list_tabs",
                description: "List all open browser tabs with their URLs and titles.",
                inputSchema: { type: "object", properties: {} },
            },
            {
                name: "browser_new_tab",
                description: "Open a new browser tab, optionally navigating to a URL. Returns snapshot of the new tab.",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: { type: "string", description: "URL to navigate to in the new tab" },
                    },
                },
            },
            {
                name: "browser_switch_tab",
                description: "Switch to a different browser tab by index. Returns snapshot of the target tab.",
                inputSchema: {
                    type: "object",
                    properties: {
                        tabIndex: { type: "number", description: "Tab index (0-based, from browser_list_tabs)" },
                    },
                    required: ["tabIndex"],
                },
            },
            {
                name: "browser_close_tab",
                description: "Close a browser tab by index. Cannot close the last remaining tab.",
                inputSchema: {
                    type: "object",
                    properties: {
                        tabIndex: { type: "number", description: "Tab index to close (0-based)" },
                    },
                    required: ["tabIndex"],
                },
            },

            // ========== Downloads/Uploads (NEW) ==========
            {
                name: "browser_list_downloads",
                description: "List recent file downloads with filenames, paths, and sizes.",
                inputSchema: { type: "object", properties: {} },
            },
            {
                name: "browser_upload_file",
                description: "Upload file(s) to a file input element by ref. Use this instead of clicking file inputs (which opens a native dialog).",
                inputSchema: {
                    type: "object",
                    properties: {
                        ref: { type: "string", description: "Ref of the file input element" },
                        filePaths: {
                            type: "array",
                            items: { type: "string" },
                            description: "Absolute paths to files to upload",
                        },
                        frameSelector: { type: "string", description: "Optional iframe selector" },
                    },
                    required: ["ref", "filePaths"],
                },
            },

            // ========== Cookies/Storage (NEW) ==========
            {
                name: "browser_get_cookies",
                description: "Get browser cookies for the current page or a specific URL.",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: { type: "string", description: "URL to get cookies for (defaults to current page)" },
                    },
                },
            },
            {
                name: "browser_set_cookie",
                description: "Set a browser cookie.",
                inputSchema: {
                    type: "object",
                    properties: {
                        name: { type: "string", description: "Cookie name" },
                        value: { type: "string", description: "Cookie value" },
                        domain: { type: "string", description: "Cookie domain" },
                        path: { type: "string", description: "Cookie path (default: '/')" },
                        secure: { type: "boolean", description: "Secure flag" },
                        httpOnly: { type: "boolean", description: "HttpOnly flag" },
                    },
                    required: ["name", "value", "domain"],
                },
            },
            {
                name: "browser_clear_cookies",
                description: "Clear browser cookies, optionally for a specific domain.",
                inputSchema: {
                    type: "object",
                    properties: {
                        domain: { type: "string", description: "Only clear cookies for this domain" },
                    },
                },
            },
            {
                name: "browser_local_storage",
                description: "Read, write, or delete localStorage entries on the current page.",
                inputSchema: {
                    type: "object",
                    properties: {
                        action: { type: "string", enum: ["get", "set", "delete", "list"], description: "Action to perform" },
                        key: { type: "string", description: "Storage key (required for get, set, delete)" },
                        value: { type: "string", description: "Value to set (required for set)" },
                    },
                    required: ["action"],
                },
            },

            // ========== Advanced ==========
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

        // ========== Navigation ==========

        if (name === "browser_navigate") {
            const waitUntil = args.waitUntil || 'domcontentloaded';
            clearRefs();
            rejectPendingWaiters(); // Cancel any pending network waiters from the previous page

            let timedOut = false;
            try {
                await p.goto(args.url, { waitUntil, timeout: 30000 });
            } catch (err) {
                if (err.name === 'TimeoutError') {
                    // Page likely loaded but waitUntil condition (e.g. networkidle) wasn't met.
                    // Fall through to snapshot the already-rendered page instead of failing.
                    timedOut = true;
                    console.warn(`[Browser] Navigation waitUntil="${waitUntil}" timed out for ${args.url}. Page may still be usable.`);
                } else {
                    throw err;
                }
            }

            const { snapshot, refs, title } = await getPageSnapshot(p, { compact: true });
            const refCount = Object.keys(refs).length;
            const timeoutNote = timedOut
                ? `⚠️ Navigation timed out waiting for "${waitUntil}" but the page appears loaded. Proceeding with current state.\n\n`
                : '';

            return {
                content: [{
                    type: "text",
                    text: `${timeoutNote}Navigated to: ${title} (${args.url})\n\n` +
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
                maxDepth: args.maxDepth,
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

        // ========== Screenshots ==========

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

        // ========== Text Extraction (Phase 7: Readability) ==========

        if (name === "browser_extract_text") {
            let html;
            if (args.selector) {
                html = await p.locator(args.selector).innerHTML({ timeout: 5000 });
            } else {
                html = await p.evaluate(() => {
                    const clone = document.body.cloneNode(true);
                    clone.querySelectorAll('script, style, noscript, svg, iframe, nav, footer, aside').forEach(el => el.remove());
                    return clone.innerHTML;
                });
            }

            let markdown;
            try {
                // Try Readability first for article-style content
                const { Readability } = require('@mozilla/readability');
                const { JSDOM } = require('jsdom');
                const dom = new JSDOM(html, { url: p.url() });
                const reader = new Readability(dom.window.document);
                const article = reader.parse();
                if (article && article.textContent && article.textContent.length > 100) {
                    const TurndownService = require('turndown');
                    const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
                    markdown = `# ${article.title}\n\n${turndown.turndown(article.content)}`;
                }
            } catch { /* readability not available or failed */ }

            if (!markdown) {
                const TurndownService = require('turndown');
                const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
                markdown = turndown.turndown(html);
            }

            const maxLen = 30000;
            const truncated = markdown.length > maxLen
                ? markdown.slice(0, maxLen) + '\n\n... (truncated)'
                : markdown;

            return { content: [{ type: "text", text: truncated }] };
        }

        // ========== Ref-Based Interactions (with Auto-Snapshot) ==========

        if (name === "browser_click") {
            const result = await handleClick(p, args);
            let text = result.message;
            if (result.success && args.autoSnapshot !== false) {
                text += await autoSnapshot(p);
            }
            return { content: [{ type: "text", text }] };
        }

        if (name === "browser_type") {
            const result = await handleType(p, args);
            let text = result.message;
            if (result.success && args.submit && args.autoSnapshot !== false) {
                text += await autoSnapshot(p);
            }
            return { content: [{ type: "text", text }] };
        }

        if (name === "browser_fill_form") {
            const result = await handleFillForm(p, args);
            let text = result.message;
            if (result.success && args.autoSnapshot !== false) {
                text += await autoSnapshot(p);
            }
            return {
                content: [{ type: "text", text }],
                isError: !result.success,
            };
        }

        if (name === "browser_select") {
            const result = await handleSelect(p, args);
            let text = result.message;
            if (result.success && args.autoSnapshot !== false) {
                text += await autoSnapshot(p);
            }
            return { content: [{ type: "text", text }] };
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
            let text = result.message;
            if (result.success && args.autoSnapshot !== false) {
                text += await autoSnapshot(p);
            }
            return { content: [{ type: "text", text }] };
        }

        if (name === "browser_drag") {
            const result = await handleDrag(p, args);
            return {
                content: [{ type: "text", text: result.message }],
                isError: !result.success,
            };
        }

        // ========== Wait ==========

        if (name === "browser_wait") {
            const result = await handleWait(p, args);
            return { content: [{ type: "text", text: `${result.message}. Current URL: ${result.url}` }] };
        }

        // ========== Network & Console (NEW) ==========

        if (name === "browser_network_log") {
            const entries = getNetworkLog({
                urlFilter: args.urlFilter,
                resourceType: args.resourceType,
                limit: args.limit,
            });
            if (args.clear) clearNetworkLog();

            if (entries.length === 0) {
                return { content: [{ type: "text", text: "No network requests captured yet." }] };
            }

            const formatted = entries.map(e => {
                let line = `${e.method} ${e.status || 'pending'} ${e.url}`;
                if (e.resourceType) line += ` [${e.resourceType}]`;
                if (e.duration) line += ` ${e.duration}ms`;
                if (e.error) line += ` ERROR: ${e.error}`;
                return line;
            }).join('\n');

            return { content: [{ type: "text", text: `## Network Log (${entries.length} entries)\n\n${formatted}` }] };
        }

        if (name === "browser_wait_for_response") {
            try {
                const entry = await waitForNetworkResponse(args.urlPattern, args.timeout || 30000);
                let text = `Response received: ${entry.status} ${entry.url}`;
                if (entry.body) {
                    const body = entry.body.length > 5000 ? entry.body.slice(0, 5000) + '...[truncated]' : entry.body;
                    text += `\n\n## Response Body\n\n${body}`;
                }
                return { content: [{ type: "text", text }] };
            } catch (err) {
                return { isError: true, content: [{ type: "text", text: err.message }] };
            }
        }

        if (name === "browser_get_response_body") {
            const result = getResponseBody(args.urlPattern);
            if (!result) {
                return { content: [{ type: "text", text: `No response body found matching "${args.urlPattern}". Try browser_network_log to see available requests.` }] };
            }
            const body = result.body.length > 10000 ? result.body.slice(0, 10000) + '...[truncated]' : result.body;
            return { content: [{ type: "text", text: `## ${result.status} ${result.url}\n\n${body}` }] };
        }

        if (name === "browser_console_messages") {
            const { messages, errors } = getConsoleMessages(args.level);
            if (args.clear) clearConsoleMessages();

            if (messages.length === 0 && errors.length === 0) {
                return { content: [{ type: "text", text: "No console messages captured." }] };
            }

            const parts = [];
            if (messages.length > 0) {
                const formatted = messages.map(m =>
                    `[${m.level}] ${m.text}${m.location ? ` (${m.location})` : ''}`
                ).join('\n');
                parts.push(`## Console Messages (${messages.length})\n\n${formatted}`);
            }
            if (errors.length > 0) {
                const formatted = errors.map(e =>
                    `${e.message}${e.stack ? '\n' + e.stack : ''}`
                ).join('\n---\n');
                parts.push(`## Page Errors (${errors.length})\n\n${formatted}`);
            }

            return { content: [{ type: "text", text: parts.join('\n\n') }] };
        }

        // ========== Resource Blocking ==========

        if (name === "browser_set_resource_blocking") {
            setBlockedTypes(args.blocked);
            const current = getBlockedTypes();
            return {
                content: [{
                    type: "text",
                    text: current.length > 0
                        ? `Resource blocking updated. Now blocking: ${current.join(', ')}`
                        : 'Resource blocking disabled. All resources will load.',
                }],
            };
        }

        // ========== Multi-Tab ==========

        if (name === "browser_list_tabs") {
            const pages = browser.pages();
            const activeIdx = getActiveTab();
            const tabs = await Promise.all(pages.map(async (pg, i) => {
                const title = await pg.title().catch(() => '');
                const url = pg.url();
                return `${i === activeIdx ? '> ' : '  '}[${i}] ${title || '(untitled)'} — ${url}`;
            }));
            return { content: [{ type: "text", text: `## Open Tabs (${pages.length})\n\n${tabs.join('\n')}` }] };
        }

        if (name === "browser_new_tab") {
            const newPage = await browser.newPage();
            setupPageListeners(newPage);
            const pages = browser.pages();
            const newIdx = pages.indexOf(newPage);
            setActiveTab(newIdx);
            await switchScreencast(browser, newPage);

            if (args.url) {
                clearRefs();
                await newPage.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            }

            const { snapshot, refs, title } = await getPageSnapshot(newPage, { compact: true });
            const refCount = Object.keys(refs).length;
            return {
                content: [{
                    type: "text",
                    text: `Opened new tab [${newIdx}]: ${title} (${newPage.url()})\n\n## Page Snapshot (${refCount} refs)\n\n${snapshot}`,
                }],
            };
        }

        if (name === "browser_switch_tab") {
            const pages = browser.pages();
            if (args.tabIndex < 0 || args.tabIndex >= pages.length) {
                return { isError: true, content: [{ type: "text", text: `Invalid tab index ${args.tabIndex}. Have ${pages.length} tabs (0-${pages.length - 1}).` }] };
            }
            const targetPage = pages[args.tabIndex];
            setActiveTab(args.tabIndex);
            await switchScreencast(browser, targetPage);
            await targetPage.bringToFront();

            const { snapshot, refs, title } = await getPageSnapshot(targetPage, { compact: true });
            const refCount = Object.keys(refs).length;
            return {
                content: [{
                    type: "text",
                    text: `Switched to tab [${args.tabIndex}]: ${title} (${targetPage.url()})\n\n## Page Snapshot (${refCount} refs)\n\n${snapshot}`,
                }],
            };
        }

        if (name === "browser_close_tab") {
            const pages = browser.pages();
            if (pages.length <= 1) {
                return { isError: true, content: [{ type: "text", text: "Cannot close the last tab." }] };
            }
            if (args.tabIndex < 0 || args.tabIndex >= pages.length) {
                return { isError: true, content: [{ type: "text", text: `Invalid tab index ${args.tabIndex}.` }] };
            }

            clearTabRefs(args.tabIndex);
            await pages[args.tabIndex].close();

            // Switch to nearest tab
            const remaining = browser.pages();
            const newIdx = Math.min(args.tabIndex, remaining.length - 1);
            setActiveTab(newIdx);
            await switchScreencast(browser, remaining[newIdx]);

            return {
                content: [{
                    type: "text",
                    text: `Closed tab [${args.tabIndex}]. Now on tab [${newIdx}]: ${remaining[newIdx].url()}`,
                }],
            };
        }

        // ========== Downloads/Uploads ==========

        if (name === "browser_list_downloads") {
            const downloads = getDownloads();
            if (downloads.length === 0) {
                return { content: [{ type: "text", text: `No downloads yet. Download directory: ${getDownloadDir()}` }] };
            }
            const formatted = downloads.map(d =>
                `${d.filename} (${(d.size / 1024).toFixed(1)}KB) — ${d.path}`
            ).join('\n');
            return { content: [{ type: "text", text: `## Downloads (${downloads.length})\n\n${formatted}` }] };
        }

        if (name === "browser_upload_file") {
            // Validate file paths: must be absolute and within allowed directories
            const allowedRoots = [USER_DATA_DIR, '/tmp', process.env.HOME ? path.join(process.env.HOME, 'Downloads') : null].filter(Boolean);
            for (const fp of args.filePaths) {
                const resolved = path.resolve(fp);
                const isAllowed = allowedRoots.some(root => resolved.startsWith(root));
                if (!isAllowed) {
                    return {
                        isError: true,
                        content: [{ type: "text", text: `Upload blocked: "${fp}" is outside allowed directories (${allowedRoots.join(', ')}). Move files to ~/Downloads or the browser profile directory first.` }],
                    };
                }
                if (!fs.existsSync(resolved)) {
                    return { isError: true, content: [{ type: "text", text: `File not found: "${fp}"` }] };
                }
            }
            const locator = refLocator(p, args.ref, args.frameSelector);
            await locator.setInputFiles(args.filePaths);
            return { content: [{ type: "text", text: `Uploaded ${args.filePaths.length} file(s) to ref=${args.ref}` }] };
        }

        // ========== Cookies/Storage ==========

        if (name === "browser_get_cookies") {
            const urls = args.url ? [args.url] : [p.url()];
            const cookies = await browser.cookies(urls);
            if (cookies.length === 0) {
                return { content: [{ type: "text", text: "No cookies found." }] };
            }
            const formatted = cookies.map(c =>
                `${c.name}=${c.value.slice(0, 50)}${c.value.length > 50 ? '...' : ''} (domain: ${c.domain}, path: ${c.path})`
            ).join('\n');
            return { content: [{ type: "text", text: `## Cookies (${cookies.length})\n\n${formatted}` }] };
        }

        if (name === "browser_set_cookie") {
            await browser.addCookies([{
                name: args.name,
                value: args.value,
                domain: args.domain,
                path: args.path || '/',
                secure: args.secure || false,
                httpOnly: args.httpOnly || false,
            }]);
            return { content: [{ type: "text", text: `Cookie "${args.name}" set for ${args.domain}` }] };
        }

        if (name === "browser_clear_cookies") {
            if (args.domain) {
                // Playwright doesn't support domain-filtered clear, so we get and remove matching
                const allCookies = await browser.cookies();
                const toKeep = allCookies.filter(c => !c.domain.includes(args.domain));
                await browser.clearCookies();
                if (toKeep.length > 0) await browser.addCookies(toKeep);
                return { content: [{ type: "text", text: `Cleared cookies for domain: ${args.domain}` }] };
            }
            await browser.clearCookies();
            return { content: [{ type: "text", text: "All cookies cleared." }] };
        }

        if (name === "browser_local_storage") {
            if (args.action === 'list') {
                const entries = await p.evaluate(() => {
                    const items = {};
                    for (let i = 0; i < localStorage.length; i++) {
                        const key = localStorage.key(i);
                        items[key] = localStorage.getItem(key).slice(0, 100);
                    }
                    return items;
                });
                const formatted = Object.entries(entries).map(([k, v]) =>
                    `${k}: ${v}${v.length >= 100 ? '...' : ''}`
                ).join('\n');
                return { content: [{ type: "text", text: formatted || "localStorage is empty." }] };
            }
            if (args.action === 'get') {
                const value = await p.evaluate((key) => localStorage.getItem(key), args.key);
                return { content: [{ type: "text", text: value !== null ? value : `Key "${args.key}" not found.` }] };
            }
            if (args.action === 'set') {
                await p.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: args.key, value: args.value });
                return { content: [{ type: "text", text: `Set localStorage["${args.key}"]` }] };
            }
            if (args.action === 'delete') {
                await p.evaluate((key) => localStorage.removeItem(key), args.key);
                return { content: [{ type: "text", text: `Deleted localStorage["${args.key}"]` }] };
            }
            return { isError: true, content: [{ type: "text", text: `Unknown action: ${args.action}` }] };
        }

        // ========== Advanced ==========

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
    console.error("Browser MCP Server V2.1 running on stdio");
}

run().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
