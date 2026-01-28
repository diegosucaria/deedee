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
 * Initialize Browser (Lazy Load or on Startup)
 * We use a persistent context.
 */
async function ensureBrowser() {
    if (page) return page;

    console.error(`[Browser] Launching browser... (Headless: ${HEADLESS}, Profile: ${USER_DATA_DIR}, Exec: ${EXECUTABLE_PATH || 'Bundled'})`);

    if (!fs.existsSync(USER_DATA_DIR)) {
        console.error(`[Browser] Creating profile directory: ${USER_DATA_DIR}`);
        fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    }

    const launchOptions = {
        headless: HEADLESS,
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] // Required for Docker
    };

    if (EXECUTABLE_PATH) {
        launchOptions.executablePath = EXECUTABLE_PATH;
    }

    browser = await chromium.launchPersistentContext(USER_DATA_DIR, launchOptions);

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
                        url: { type: "string", description: "The URL to visit" }
                    },
                    required: ["url"]
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
                description: "Click an element identified by a CSS selector.",
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
                description: "Type text into an input field.",
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
        if (name === "browser_click_vision") {
            // ... existing vision logic ...
            // Re-implementing simplified to keep context
            const description = args.description;
            console.error(`[Browser] Vision Click requested: "${description}"`);

            const buffer = await p.screenshot({ fullPage: false });
            const base64Image = buffer.toString('base64');
            const { width, height } = p.viewportSize() || { width: 1280, height: 800 };

            if (!process.env.GOOGLE_API_KEY) {
                throw new Error("GOOGLE_API_KEY is missing. Cannot use vision capabilities.");
            }

            const { GoogleGenerativeAI } = await import("@google/genai");
            const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
            const modelName = process.env.WORKER_FLASH || "gemini-2.0-flash-exp";
            const model = genAI.getGenerativeModel({ model: modelName });

            const prompt = `
            You are a UI locator. 
            Screen size: ${width}x${height}.
            
            Task: Find the center coordinates of the element described as: "${description}".
            
            Return ONLY a JSON object with "x" (int) and "y" (int).
            Example: {"x": 100, "y": 200}
            If not found, return {"error": "not found"}.
            `;

            const result = await model.generateContent([
                prompt,
                { inlineData: { data: base64Image, mimeType: "image/png" } }
            ]);

            const response = await result.response;
            const text = response.text();
            const jsonText = text.replace(/```json/g, '').replace(/```/g, '').trim();

            let coords;
            try {
                coords = JSON.parse(jsonText);
            } catch (e) {
                throw new Error(`Failed to parse vision response: ${text}`);
            }

            if (coords.error) {
                return { isError: true, content: [{ type: "text", text: `Vision could not find element: ${description}` }] };
            }

            await p.mouse.click(coords.x, coords.y);
            return { content: [{ type: "text", text: `Clicked visually at (${coords.x}, ${coords.y})` }] };
        }

        // --- STANDARD TOOLS ---
        if (name === "browser_navigate") {
            await p.goto(args.url, { waitUntil: 'domcontentloaded' });
            const title = await p.title();
            return { content: [{ type: "text", text: `Navigated to: ${title} (${args.url})` }] };
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
            const safeScript = args.script.includes('return') ? args.script : `return ${args.script}`;
            // Evaluate as function body to allow 'return'
            const result = await p.evaluate(new Function(safeScript));
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
