#!/usr/bin/env node

/**
 * MCP Server - Browser (Playwright)
 * Provides agentic browsing capabilities: Navigate, Click, Type, Screenshot, Extract.
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { chromium } = require('playwright');
const TurndownService = require('turndown');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { z } = require('zod'); // For easier schema definition later if needed, though MCP uses JSON Schema

// Load environment variables
dotenv.config();

// STATE
let browser = null;
let context = null;
let page = null;

// CONSTANTS
const USER_DATA_DIR = process.env.BROWSER_USER_DATA_DIR || path.join(__dirname, '../../../data/browser_profile');
const HEADLESS = process.env.BROWSER_HEADLESS !== 'false'; // Default true
const EXECUTABLE_PATH = process.env.BROWSER_EXECUTABLE_PATH || undefined;

const server = new Server(
    {
        name: "deedee-browser-server",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

/**
 * Force cleanup of profile lock if it exists (Docker crash recovery)
 */
function cleanProfile() {
    try {
        const lockFile = path.join(USER_DATA_DIR, 'SingletonLock');
        if (fs.existsSync(lockFile)) {
            console.warn(`[Browser] Found stale SingletonLock at ${lockFile}. Removing...`);
            fs.unlinkSync(lockFile); // Only delete the symlink/file itself
        }

        // Also clean singleton cookie/sockets? Usually lock is the main blocker.
        // SingletonCookie, SingletonSocket
    } catch (e) {
        console.error('[Browser] Failed to clean profile:', e);
    }
}

/** 
 * Aggressively clean up all Chromium lock files
 */
function nukeProfileLocks() {
    try {
        const locks = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
        locks.forEach(f => {
            const p = path.join(USER_DATA_DIR, f);
            if (fs.existsSync(p)) {
                try { fs.unlinkSync(p); } catch (e) { }
            }
        });
    } catch (e) { }
}

/**
 * Initialize Browser (Lazy Load or on Startup)
 * We use a persistent context.
 */
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
        console.error(`[Browser] Creating profile directory: ${USER_DATA_DIR}`);
        fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    } else {
        // Try to clean stale locks
        cleanProfile();
        nukeProfileLocks();
    }

    const launchOptions = {
        headless: HEADLESS,
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu' // Often helps in Docker
        ],
        ignoreDefaultArgs: ['--enable-automation'] // Reduce detection?
    };

    if (EXECUTABLE_PATH) {
        launchOptions.executablePath = EXECUTABLE_PATH;
    }

    try {
        browser = await chromium.launchPersistentContext(USER_DATA_DIR, launchOptions);
    } catch (launchErr) {
        console.error('[Browser] Launch failed. Retrying with cleaner profile...', launchErr);
        // Force nuke? No, secrets. Just retry once.
        console.log('[Browser] Retrying launch with aggressive cleanup...');
        nukeProfileLocks();
        cleanProfile();
        // Small delay
        await new Promise(r => setTimeout(r, 1000));
        browser = await chromium.launchPersistentContext(USER_DATA_DIR, launchOptions);
    }

    // Get first page or create new
    const pages = browser.pages();
    page = pages.length > 0 ? pages[0] : await browser.newPage();

    return page;
}

// --- TOOL HANDLERS ---

const SECRETS_FILE = path.join(USER_DATA_DIR, 'browser-secrets.json');

/**
 * Load secrets from JSON file
 */
function loadSecrets() {
    try {
        if (!fs.existsSync(SECRETS_FILE)) return {};
        return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf-8'));
    } catch (e) {
        console.error('[Browser] Failed to load secrets:', e);
        return {};
    }
}

/**
 * Save secret to JSON file
 */
// function saveSecret removed (Agent cannot save secrets)

// ... inside handlers ...

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "browser_navigate",
                description: "Navigate the browser to a specific URL.",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: { type: "string", description: "The URL to visit" },
                        waitUntil: { type: "string", description: "When to consider navigation succeeded (load, domcontentloaded, networkidle). Default: domcontentloaded", enum: ["load", "domcontentloaded", "networkidle"] },
                        timeout: { type: "integer", description: "Timeout in milliseconds (default: 30000)" }
                    },
                    required: ["url"]
                }
            },
            {
                name: "browser_get_accessibility_tree",
                description: "Get the simplified accessibility tree of the page. Useful for understanding complex web apps where Markdown is insufficient.",
                inputSchema: {
                    type: "object",
                    properties: {}
                }
            },
            {
                name: "browser_screenshot",
                description: "Take a screenshot of the current page. Returns base64 image.",
                inputSchema: {
                    type: "object",
                    properties: {
                        fullPage: { type: "boolean", description: "Capture full scrollable page (default false)" }
                    }
                }
            },
            {
                name: "browser_extract_text",
                description: "Extract the text content of the page as Markdown.",
                inputSchema: {
                    type: "object",
                    properties: {}
                }
            },
            {
                name: "browser_click",
                description: "Click an element identified by a CSS selector. IF THIS FAILS (e.g. 'Element not found'), do NOT retry blindly. IMMEDIATELY switch to 'browser_click_vision_annotated'.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector of element to click" }
                    },
                    required: ["selector"]
                }
            },
            {
                name: "browser_type",
                description: "Type text into an input field. If the field is hard to select, use 'browser_click_vision_annotated' to click it first.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector of input field" },
                        text: { type: "string", description: "Text to type" }
                    },
                    required: ["selector", "text"]
                }
            },
            {
                name: "browser_list_secrets",
                description: "List available secret keys that can be used with browser_fill_secret.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "browser_fill_secret",
                description: "Securely type a secret value into a field. use browser_list_secrets to see available keys.",
                inputSchema: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector of input field" },
                        secretKey: { type: "string", description: "Name of the secret key (e.g. CARD_NUMBER)" }
                    },
                    required: ["selector", "secretKey"]
                }
            },
            // browser_save_secret removed
            {
                name: "browser_run_script",
                description: "Execute custom JavaScript in the page context.",
                inputSchema: {
                    type: "object",
                    properties: {
                        script: { type: "string", description: "JavaScript code to run. Return value will be captured." }
                    },
                    required: ["script"]
                }
            },
            {
                name: "browser_click_vision",
                description: "Click an element by visual description using AI Vision (Use when selectors fail).",
                inputSchema: {
                    type: "object",
                    properties: {
                        description: { type: "string", description: "Visual description of the element (e.g. 'The red Sign Up button in the top right')" }
                    },
                    required: ["description"]
                }
            },
            {
                name: "browser_click_vision_annotated",
                description: "Click an element by visual description using Annotated Vision (Set-of-Mark). Highly reliable.",
                inputSchema: {
                    type: "object",
                    properties: {
                        description: { type: "string", description: "Visual description of the element (e.g. 'The red Sign Up button in the top right')" }
                    },
                    required: ["description"]
                }
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        // ... (browser initialization logic remains same, handled by ensureBrowser)
        // Only initialize browser if tool requires it
        const requiresBrowser = name !== "browser_save_secret" && name !== "browser_list_secrets";
        let p = null;

        if (requiresBrowser) {
            p = await ensureBrowser();
        }

        // --- VISION TOOL LOGIC ---
        if (name === "browser_click_vision_annotated") {
            const description = args.description;
            console.error(`[Browser] Annotated Vision Click requested: "${description}"`);

            if (!process.env.GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY missing.");

            // 1. Inject Labels (Set-of-Mark)
            // simplified script to label interactive elements
            const labels = await p.evaluate(() => {
                const interactives = Array.from(document.querySelectorAll('button, a, input, [role="button"]'));
                // Filter visible
                const visible = interactives.filter(el => {
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0 &&
                        rect.top >= 0 && rect.left >= 0 &&
                        rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;
                });

                const map = {};
                visible.forEach((el, index) => {
                    const id = `agent-label-${index}`;
                    el.dataset.agentLabelId = id;

                    // Create overlay
                    const rect = el.getBoundingClientRect();
                    const overlay = document.createElement('div');
                    overlay.id = id;
                    overlay.style.position = 'fixed';
                    overlay.style.left = rect.left + 'px';
                    overlay.style.top = rect.top + 'px';
                    overlay.style.zIndex = '999999';
                    overlay.style.background = 'yellow';
                    overlay.style.color = 'black';
                    overlay.style.border = '1px solid black';
                    overlay.style.fontWeight = 'bold';
                    overlay.style.fontSize = '12px';
                    overlay.style.padding = '2px';
                    overlay.innerText = index.toString();

                    document.body.appendChild(overlay);
                    map[index] = id;
                });
                return map;
            });

            // 2. Screenshot
            const buffer = await p.screenshot({ fullPage: false });
            const base64Image = buffer.toString('base64');
            const { width, height } = p.viewportSize() || { width: 1280, height: 800 };

            // 3. Cleanup labels immediately
            await p.evaluate(() => {
                document.querySelectorAll('div[id^="agent-label-"]').forEach(el => el.remove());
                // Note: we leave data attributes for a moment to identify? No, we use index.
            });

            // 4. Vision
            // Use new @google/genai SDK (V1)
            const { GoogleGenAI } = require("@google/genai");
            const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
            const modelName = process.env.WORKER_FLASH || "gemini-2.0-flash-exp";

            const promptText = `
             You are a UI driver.
             Task: Identify the numeric label ID for the element described as: "${description}".
             Return ONLY a JSON object with "labelIndex" (int).
             Example: {"labelIndex": 5}
             If not found, return {"error": "not found"}.
             `;

            try {
                const result = await client.models.generateContent({
                    model: modelName,
                    contents: [
                        {
                            role: 'user',
                            parts: [
                                { text: promptText },
                                { inlineData: { mimeType: "image/png", data: base64Image } }
                            ]
                        }
                    ]
                });

                // New SDK response structure
                // New SDK response structure
                // New SDK response structure
                if (!result.response.candidates || result.response.candidates.length === 0) {
                    return { isError: true, content: [{ type: "text", text: "Vision API returned no candidates. Safety block or error." }] };
                }
                const responseText = result.response.candidates[0].content.parts[0].text;
                const jsonText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();

                // Extract Usage
                const usage = result.response.usageMetadata;
                const meta = usage ? {
                    usage: {
                        model: modelName,
                        inputTokens: usage.promptTokenCount,
                        outputTokens: usage.candidatesTokenCount,
                        totalTokens: usage.totalTokenCount
                    }
                } : undefined;

                let targetParams;
                try { targetParams = JSON.parse(jsonText); } catch (e) { throw new Error(`Failed to parse: ${responseText}`); }

                if (targetParams.error || targetParams.labelIndex === undefined) {
                    return { isError: true, content: [{ type: "text", text: `Element not found: ${description}` }] };
                }

                // 5. Click by finding the element with that index
                await p.evaluate((index) => {
                    const interactives = Array.from(document.querySelectorAll('button, a, input, [role="button"]'));
                    // Re-filter identical logic
                    const visible = interactives.filter(el => {
                        const rect = el.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0 &&
                            rect.top >= 0 && rect.left >= 0 &&
                            rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;
                    });

                    const target = visible[index];
                    if (target) {
                        target.click();
                    } else {
                        throw new Error('Element index mismatch or shift');
                    }
                }, targetParams.labelIndex);

                return {
                    content: [{ type: "text", text: `Clicked label ${targetParams.labelIndex} ("${description}")` }],
                    _meta: meta
                };

            } catch (genError) {
                console.error("Vision API Error:", genError);
                throw new Error(`Vision AI failed: ${genError.message}`);
            } // Close try block for generation
        } // Close if block (this is tricky with replace_file_content lines, checking boundaries)

        // Wait, I am replacing a huge chunk.
        // The EndLine 373 in view_file was "const visible = ...".
        // My replacement content seems to duplicate the click logic which was AFTER line 373?
        // No, line 373 in view_file (from Step 1934) is inside the evaluate callback.
        // I need to be careful.

        // Let's adjust the replace to cover exactly the Vision block logic until the click implementation.
        // Actually, the previous implementation had the click logic separated.
        // My ReplacementContent INCLUDES the click logic.
        // So I should replace until the end of the block?
        // Let's look at the file content again.
        // Lines 352-383 covers Vision setup + generation + parsing + click + return.
        // Line 384 is closing brace for `if (name === "browser_click_vision_annotated") {`

        // So I should replace lines 352 to 383 (exclusive of 384).



        if (name === "browser_click_vision") {
            // Placeholder for vision click implementation if needed, or remove if unused/duplicate of annotated
            const description = args.description;
            // For now, let's just implement it or throw not implemented if it's not ready. 
            // But looking at schema, it IS defined. 
            // Let's defer to error or simple implementation?
            // Actually, the previous code had NO implementation for this specific block, just opened it.
            // Let's assume we want to fall through or handle it.
            // But wait, the previous code swallows navigate. 

            // Re-implementing correctly:
            console.log("Vision click (simple) not fully implemented, falling back to annotated or error.");
            throw new Error("Please use browser_click_vision_annotated for better reliability.");
        }

        // --- STANDARD TOOLS ---

        if (name === "browser_navigate") {
            const waitUntil = args.waitUntil || 'domcontentloaded';
            const timeout = args.timeout || 30000;

            await p.goto(args.url, { waitUntil: waitUntil, timeout: timeout });
            const title = await p.title();
            return { content: [{ type: "text", text: `Navigated to: ${title} (${args.url})` }] };
        }

        if (name === "browser_get_accessibility_tree") {
            if (!p) throw new Error("Browser page not available");
            // Wait for page to be reasonably ready to avoid "not ready" errors
            try { await p.waitForLoadState('domcontentloaded', { timeout: 2000 }); } catch (e) { /* ignore timeout */ }
            if (!p.accessibility) throw new Error("Accessibility API unavailable");

            const snapshot = await p.accessibility.snapshot({ interestingOnly: true });

            // Helper to recursively simplify tree
            function simplifyNode(node) {
                const simple = {
                    role: node.role,
                    name: node.name
                };
                if (node.value) simple.value = node.value;
                if (node.description) simple.description = node.description;
                if (node.checked) simple.checked = node.checked;
                if (node.children && node.children.length > 0) {
                    simple.children = node.children.map(simplifyNode);
                }
                return simple;
            }

            const simplified = snapshot ? simplifyNode(snapshot) : { error: "No accessibility tree found" };
            return { content: [{ type: "text", text: JSON.stringify(simplified, null, 2) }] };
        }

        if (name === "browser_screenshot") {
            const buffer = await p.screenshot({ fullPage: args.fullPage || false });
            const base64 = buffer.toString('base64');
            return {
                content: [{
                    type: "image",
                    data: base64,
                    mimeType: "image/png"
                }]
            };
        }

        if (name === "browser_extract_text") {
            const html = await p.content();
            const turndownService = new TurndownService();
            turndownService.remove(['script', 'style', 'noscript', 'svg']);
            const markdown = turndownService.turndown(html);
            return { content: [{ type: "text", text: markdown }] };
        }

        if (name === "browser_click") {
            await p.click(args.selector);
            return { content: [{ type: "text", text: `Clicked ${args.selector}` }] };
        }

        if (name === "browser_type") {
            await p.fill(args.selector, args.text);
            return { content: [{ type: "text", text: `Typed into ${args.selector}` }] };
        }

        // browser_save_secret implementation removed

        if (name === "browser_list_secrets") {
            const fileSecrets = loadSecrets();
            const envSecrets = Object.keys(process.env).filter(k =>
                k.includes('PASSWORD') || k.includes('USER') || k.includes('TOKEN')
            );
            const allKeys = [...new Set([...Object.keys(fileSecrets), ...envSecrets])];
            return { content: [{ type: "text", text: JSON.stringify(allKeys) }] };
        }

        if (name === "browser_fill_secret") {
            // Priority: File > Env
            const fileSecrets = loadSecrets();
            let val = fileSecrets[args.secretKey];

            if (!val) {
                val = process.env[args.secretKey];
            }

            if (!val) {
                return { isError: true, content: [{ type: "text", text: `Secret key '${args.secretKey}' not found.` }] };
            }
            await p.fill(args.selector, val);
            return { content: [{ type: "text", text: `Securely typed secret for ${args.selector}` }] };
        }

        if (name === "browser_run_script") {
            const safeScript = args.script;
            // FIX: Use AsyncFunction to allow top-level await in scripts
            // This is critical for complex automation (e.g. waiting for elements)
            const result = await p.evaluate(async (scriptBody) => {
                const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
                const fn = new AsyncFunction(scriptBody);
                return await fn();
            }, safeScript);

            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }

        throw new Error(`Tool ${name} not implemented.`);
    } catch (err) {
        console.error(`[Browser] Error executing ${name}:`, err);
        return {
            isError: true,
            content: [{ type: "text", text: `Error: ${err.message}` }]
        };
    }
});

async function run() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Browser MCP Server running on stdio");
}

run().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
