const CDP = require('chrome-remote-interface');

// Keep client active? Or connect per request?
// RDP allows multiple clients. Per request is safer for statelessness.

async function handleBrowserAction(args) {
    const { action, url, selector, javascript } = args;
    let client;

    try {
        // Connect to local Chrome on port 9222
        client = await CDP({ host: '127.0.0.1', port: 9222 });
        const { Page, Runtime, DOM, Input } = client;

        if (action === 'navigate') {
            await Page.enable();
            await Page.navigate({ url });
            await Page.loadEventFired();
            return { content: [{ type: 'text', text: `Navigated to ${url}` }] };
        }

        if (action === 'type') {
            // Types into the FOCUSED element.
            // Model must click first.
            const { text } = args;
            if (!text) throw new Error('Text is required for type action');

            await Input.insertText({ text });
            return { content: [{ type: 'text', text: `Typed "${text}" into focused element.` }] };
        }

        if (action === 'key') {
            // Dispatches a key event (e.g. Enter, Tab)
            const { key } = args;
            // Mapping common keys to CDP format if needed, or just assuming raw
            // CDP Input.dispatchKeyEvent requires type, windowsVirtualKeyCode etc.
            // Simplified: Use 'char' for text, 'rawKeyDown'/'keyUp' for special.

            // For 'Enter':
            if (key === 'Enter') {
                await Input.dispatchKeyEvent({ type: 'rawKeyDown', windowsVirtualKeyCode: 13, unmodifiedText: '\r', text: '\r' });
                await Input.dispatchKeyEvent({ type: 'char', text: '\r', unmodifiedText: '\r' });
                await Input.dispatchKeyEvent({ type: 'keyUp', windowsVirtualKeyCode: 13, unmodifiedText: '\r', text: '\r' });
            } else if (key === 'Tab') {
                const k = 9;
                await Input.dispatchKeyEvent({ type: 'rawKeyDown', windowsVirtualKeyCode: k });
                await Input.dispatchKeyEvent({ type: 'keyUp', windowsVirtualKeyCode: k });
            } else {
                throw new Error(`Key ${key} not yet supported in simple bridge. Use text for typing.`);
            }
            return { content: [{ type: 'text', text: `Pressed ${key}` }] };
        }

        if (action === 'evaluate') {
            const result = await Runtime.evaluate({ expression: javascript, returnByValue: true });
            return { content: [{ type: 'text', text: JSON.stringify(result.result.value) }] };
        }

        if (action === 'activeTab') {
            const tabs = await CDP.List({ host: '127.0.0.1', port: 9222 });
            const active = tabs.find(t => t.type === 'page' && t.url !== 'about:blank'); // rough heuristic
            return { content: [{ type: 'text', text: JSON.stringify(active || tabs[0]) }] };
        }

        throw new Error(`Unknown action: ${action}`);

    } catch (err) {
        return {
            content: [{ type: 'text', text: `Browser Error: ${err.message}. Is Chrome running with --remote-debugging-port=9222?` }],
            isError: true
        };
    } finally {
        if (client) {
            await client.close();
        }
    }
}

const macBrowserTool = {
    name: "mac_browser",
    description: "Control local Chrome on Mac. Requires Chrome started with --remote-debugging-port=9222.",
    inputSchema: {
        type: "object",
        properties: {
            action: {
                type: "string",
                enum: ["navigate", "evaluate", "activeTab", "type", "key"],
                description: "Action to perform"
            },
            url: { type: "string" },
            javascript: { type: "string", description: "JS code to evaluate (return value is captured)" },
            text: { type: "string", description: "Text to type (for 'type' action)" },
            key: { type: "string", description: "Key to press (e.g. 'Enter', 'Tab')" }
        },
        required: ["action"]
    },
    handler: handleBrowserAction
};

module.exports = { macBrowserTool };
