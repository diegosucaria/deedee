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
                        secretKey: { type: "string", description: "Name of the secret env var (e.g. AMAZON_PASSWORD)" }
                    },
                    required: ["selector", "secretKey"]
                }
            },
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
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        const p = await ensureBrowser();
        if (name === "browser_navigate") {
            await p.goto(args.url, { waitUntil: 'domcontentloaded' });
            const title = await p.title();
            return { content: [{ type: "text", text: `Navigated to: ${title} (${args.url})` }] };
        }

        if (name === "browser_screenshot") {
            const buffer = await p.screenshot({ fullPage: args.fullPage || false });
            const base64 = buffer.toString('base64');
            // Return as image if MCP supports it, otherwise text base64? 
            // Gemini usually expects inline data. MCP spec says 'embedded resource' or specific content types.
            // For now, let's return it as a text block with a prefix OR strictly as resource if client supports.
            // Ideally: { type: "image", data: base64, mimeType: "image/png" } but SDK might differ.
            // Checking SDK types... content is (TextContent | ImageContent | EmbeddedResource)[]
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

        if (name === "browser_list_secrets") {
            // Filter env vars that likely represent secrets for browsing? 
            // Or just allow specific allow-list? 
            // For simplicity: Return keys containing "PASSWORD", "User", "TOKEN" or explicit allow list?
            // Let's rely on explicit allow list or convention. 
            // Better: Return ALL keys from .env that are NOT system ones? 
            // Security risk. let's return keys that start with "SECRET_" or end with "_PASSWORD" / "_USER".
            const keys = Object.keys(process.env).filter(k =>
                k.includes('PASSWORD') || k.includes('USER') || k.includes('TOKEN')
            );
            return { content: [{ type: "text", text: JSON.stringify(keys) }] };
        }

        if (name === "browser_fill_secret") {
            const val = process.env[args.secretKey];
            if (!val) {
                return { isError: true, content: [{ type: "text", text: `Secret key '${args.secretKey}' not found in environment.` }] };
            }
            await p.fill(args.selector, val);
            return { content: [{ type: "text", text: `Securely typed secret for ${args.selector}` }] };
        }

        if (name === "browser_run_script") {
            const result = await p.evaluate(args.script);
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
