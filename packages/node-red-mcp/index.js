#!/usr/bin/env node

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { NodeREDClient } = require('./src/client');
require('dotenv').config();

const NODE_RED_URL = process.env.NODE_RED_URL;
const NODE_RED_USERNAME = process.env.NODE_RED_USERNAME;
const NODE_RED_PASSWORD = process.env.NODE_RED_PASSWORD;

if (!NODE_RED_URL) {
    console.error("Error: NODE_RED_URL environment variable is required.");
    process.exit(1);
}

const client = new NodeREDClient(NODE_RED_URL, NODE_RED_USERNAME, NODE_RED_PASSWORD);

// Helper to ensure auth
async function ensureAuth() {
    if (!client.token && (NODE_RED_USERNAME && NODE_RED_PASSWORD)) {
        await client.authenticate();
    }
}

const server = new Server(
    {
        name: "node-red-mcp",
        version: "0.1.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "node_red_list_flows",
                description: "List all active Node-RED flows (tabs). STRICTLY FOR HOME ASSISTANT AUTOMATION ONLY. Do not use for general purpose computing.",
                inputSchema: {
                    type: "object",
                    properties: {},
                    required: []
                }
            },
            {
                name: "node_red_get_flow",
                description: "Get the full JSON definition of a specific flow (tab). STRICTLY FOR HOME ASSISTANT AUTOMATION ONLY.",
                inputSchema: {
                    type: "object",
                    properties: {
                        flowId: { type: "string", description: "The ID of the flow/tab to retrieve" }
                    },
                    required: ["flowId"]
                }
            },
            {
                name: "node_red_update_flow",
                description: "Update a flow configuration. WARNING: Replaces content. STRICTLY FOR HOME ASSISTANT AUTOMATION ONLY. Do not use for external scraping or general API tasks.",
                inputSchema: {
                    type: "object",
                    properties: {
                        flowId: { type: "string", description: "The ID of the flow/tab to update" },
                        nodes: {
                            type: "string",
                            description: "JSON string representing the array of node objects for this flow."
                        }
                    },
                    required: ["flowId", "nodes"]
                }
            }
        ],
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    await ensureAuth();

    switch (request.params.name) {
        case "node_red_list_flows": {
            try {
                const flows = await client.listFlows();
                const totalCount = Array.isArray(flows) ? flows.length : 0;
                console.error(`[NodeRED] Found ${totalCount} items in /flows response.`);

                // Debug: Log first item to check structure
                if (totalCount > 0) {
                    console.error('[NodeRED] Sample item:', JSON.stringify(flows[0]));
                }

                // We only want the tabs usually? Or the full dump?
                // The API /flows returns everything (nodes + tabs).
                // Let's filter to just type: 'tab' for the list
                // Or maybe return a summary.
                // If the user wants to see everything, they can.
                // But for "list flows", let's return tabs.
                const tabs = Array.isArray(flows) ? flows.filter(n => n.type === 'tab') : [];
                console.error(`[NodeRED] Returning ${tabs.length} tabs.`);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(tabs, null, 2)
                    }]
                };
            } catch (err) {
                return {
                    content: [{ type: "text", text: `Error: ${err.message}` }],
                    isError: true,
                };
            }
        }

        case "node_red_get_flow": {
            try {
                const { flowId } = request.params.arguments;
                // /flow/:id returns the flow object + its nodes usually?
                // Or try to filter from listFlows?
                // Client has getFlow(id).
                const flow = await client.getFlow(flowId);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(flow, null, 2)
                    }]
                };
            } catch (err) {
                return {
                    content: [{ type: "text", text: `Error: ${err.message}` }],
                    isError: true,
                };
            }
        }

        case "node_red_update_flow": {
            try {
                const { flowId, nodes } = request.params.arguments;
                let parsedNodes;
                try {
                    parsedNodes = typeof nodes === 'string' ? JSON.parse(nodes) : nodes;
                } catch (e) {
                    throw new Error("Invalid JSON in 'nodes' argument.");
                }

                // API expects the flow object.
                // We might need to wrap it?
                // PUT /flow/:id expects the flow configuration.
                const result = await client.updateFlow(flowId, {
                    id: flowId,
                    nodes: parsedNodes
                });

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(result, null, 2)
                    }]
                };
            } catch (err) {
                return {
                    content: [{ type: "text", text: `Error: ${err.message}` }],
                    isError: true,
                };
            }
        }

        default:
            throw new Error("Unknown tool");
    }
});

async function run() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Node-RED MCP Server running on stdio");
}

run().catch((error) => {
    console.error("Fatal error running server:", error);
    process.exit(1);
});
