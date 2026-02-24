require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

// Tools
const { macShellTool } = require('./tools/shell');
const { macInputTool } = require('./tools/input');
const { macBrowserTool } = require('./tools/browser');

const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3005;

// Token Management
let TOKEN = process.env.BRIDGE_TOKEN;
let isNewToken = false;

if (!TOKEN) {
    // 1. Check if it exists in .env but wasn't loaded (e.g. first run)
    const envPath = path.resolve(__dirname, '../.env');
    let envContent = '';

    if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');
        const match = envContent.match(/BRIDGE_TOKEN=(.*)/);
        if (match) {
            TOKEN = match[1].trim();
        }
    }

    // 2. Generate if truly missing
    if (!TOKEN) {
        console.log('[Bridge] No BRIDGE_TOKEN found. Generating a new one...');
        TOKEN = uuidv4();

        // Append to .env
        const newContent = envContent + (envContent.endsWith('\n') ? '' : '\n') + `BRIDGE_TOKEN=${TOKEN}\n`;
        fs.writeFileSync(envPath, newContent);
        console.log(`[Bridge] ✅ Generated new token and saved to ${envPath}`);
        isNewToken = true;
    }
}

// Ensure process.env is updated for other modules if needed
process.env.BRIDGE_TOKEN = TOKEN;

app.use(cors());
app.use(express.json());

// Registry
const tools = [
    macShellTool,
    macInputTool,
    macBrowserTool
];

// --- MCP SSE Transport ---

let clients = []; // Active SSE connections

app.get('/sse', (req, res) => {
    // Auth Check
    const authHeader = req.headers.authorization;
    if (TOKEN && (!authHeader || authHeader !== `Bearer ${TOKEN}`)) {
        console.warn('[Bridge] Unauthorized connection attempt.');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    console.log('[Bridge] Client connected via SSE');

    // SSE Headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });

    const clientId = uuidv4();
    const newClient = {
        id: clientId,
        res
    };
    clients.push(newClient);

    // Initial Endpoint Event (MCP Spec)
    // We tell the client where to post messages (our /message endpoint)
    const endpointEvent = {
        type: "endpoint",
        endpoint: "/message"
    };
    res.write(`event: endpoint\ndata: ${JSON.stringify(endpointEvent)}\n\n`);

    req.on('close', () => {
        console.log(`[Bridge] Client ${clientId} disconnected`);
        clients = clients.filter(c => c.id !== clientId);
    });
});

app.post('/message', async (req, res) => {
    // Logic: MCP Client (DeeDee) sends a JSON-RPC Request via POST
    // We handle it and send JSON-RPC Response via THIS HTTP Response (if synchronous) 
    // OR via SSE (if we want async push, but standard HTTP transport usually responds directly).

    // Wait... standard MCP over SSE:
    // Client connects to SSE to receive Events/Notifications (and potentially server-initiated requests).
    // Client sends Requests via POST.
    // Server *responds* to POST with the JSON-RPC Response.

    const body = req.body;
    console.log('[Bridge] Received Message:', JSON.stringify(body).slice(0, 100));

    // Handle JSON-RPC
    if (body.method === 'tools/list') {
        const response = {
            jsonrpc: "2.0",
            id: body.id,
            result: {
                tools: tools.map(t => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: t.inputSchema
                }))
            }
        };
        return res.json(response);
    }

    if (body.method === 'tools/call') {
        const { name, arguments: args } = body.params;
        const tool = tools.find(t => t.name === name);

        if (!tool) {
            return res.json({
                jsonrpc: "2.0",
                id: body.id,
                error: { code: -32601, message: "Tool not found" }
            });
        }

        try {
            const result = await tool.handler(args); // Should return { content: [...] }
            return res.json({
                jsonrpc: "2.0",
                id: body.id,
                result: result // MCP expects { content: ... } inside result
            });
        } catch (e) {
            return res.json({
                jsonrpc: "2.0",
                id: body.id,
                error: { code: -32000, message: e.message }
            });
        }
    }

    if (body.method === 'initialize') {
        return res.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
                protocolVersion: "2024-11-05",
                capabilities: {
                    tools: {}
                },
                serverInfo: {
                    name: "MacBridge",
                    version: "1.0.0"
                }
            }
        });
    }

    // Default
    res.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
});

app.listen(PORT, () => {
    console.log(`[Bridge] Mac Bridge listening on port ${PORT}`);
    if (isNewToken) {
        console.log(`[Bridge] 🔒 Authorization Token: ${TOKEN}`);
        console.log(`[Bridge] Copy the token above to DeeDee's configuration.`);
    } else {
        console.log(`[Bridge] 🔒 Token loaded. Service secure.`);
    }
});
