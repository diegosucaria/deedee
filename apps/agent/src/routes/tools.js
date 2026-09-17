const express = require('express');
const crypto = require('crypto');

const { toolDefinitions } = require('../tools-definition');
const { ApprovalService } = require('../services/approval-service');

function createToolRouter(agent) {
    const router = express.Router();

    // --- Live Tool Sync ---
    router.get('/internal/tools', async (req, res) => {
        if (!agent || !agent.mcp) return res.status(503).json({ error: 'Agent not ready' });
        try {
            const mcpTools = await agent.mcp.getTools();

            // Extract internal tools from Gemini definition format
            const internalTools = toolDefinitions.flatMap(def => def.functionDeclarations || []);

            // Merge both lists
            const allTools = [...internalTools, ...mcpTools];

            res.json({ tools: allTools });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/internal/mcp/status', async (req, res) => {
        if (!agent || !agent.mcp) return res.status(503).json({ error: 'Agent not ready' });
        try {
            const servers = await agent.mcp.getStatus();
            res.json({ servers });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // The live voice session runs tools through this route instead of the chat
    // loop, so the loop's gate never saw them: the deny-list, the safety rules,
    // the floor and the guardian all sat in the loop. They run here too now.
    // A paused call sends its card to the owner's notification channel (a live
    // session is not a chat he can answer in), and the model reads the same
    // "Action PAUSED" text it reads in a chat.
    router.post('/tools/execute', async (req, res) => {
        if (!agent || !agent.toolExecutor) return res.status(503).json({ error: 'Agent not ready' });
        try {
            const { name, args } = req.body;
            console.log(`[Agent] Executing tool request from Live Client: ${name}`, args);

            const message = { role: 'user', content: `[live] ${name}`, source: 'live', metadata: { chatId: 'live-session' } };
            // Context simulation for the tool executor
            const context = {
                message,
                sendCallback: async (msg) => console.log('[Agent] Live Tool Output:', msg), // No-op for direct response
                processMessage: agent.processMessage,
                callServices: { client: agent.client, interface: agent.interface }
            };

            if (agent.approvals && typeof agent.approvals.review === 'function') {
                const run = ApprovalService.newRun(crypto.randomUUID());
                const serverName = agent.mcp?.toolMap?.get?.(name)?.name || null;
                // Nothing here tracks a run's reading, so the checks a chat run
                // answers with its history count as unknown, which asks.
                const review = await agent.approvals.review({
                    message, toolName: name, args, serverName, run, historyUntrusted: null, foreignText: null
                });
                if (!review.run) {
                    console.log(`[Agent] Live tool ${name} held by the approval gate (${review.status}).`);
                    return res.json({ result: review.result, gated: true, status: review.status });
                }
            } else {
                console.warn('[Agent] Approvals unavailable; refusing the live tool call.');
                return res.status(503).json({ error: 'Approvals not initialized' });
            }

            const result = await agent.toolExecutor.execute(name, args, context);
            res.json({ result });
        } catch (error) {
            console.error('[Agent] Live Tool Execution Failed:', error);
            res.status(500).json({ error: error.message });
        }
    });

    return router;
}

module.exports = { createToolRouter };
