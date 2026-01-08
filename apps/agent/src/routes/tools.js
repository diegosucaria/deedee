const express = require('express');

const { toolDefinitions } = require('../tools-definition');

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

    router.post('/tools/execute', async (req, res) => {
        if (!agent || !agent.toolExecutor) return res.status(503).json({ error: 'Agent not ready' });
        try {
            const { name, args } = req.body;
            console.log(`[Agent] Executing tool request from Live Client: ${name}`, args);

            // Context simulation for the tool executor
            const context = {
                message: { source: 'live', metadata: { chatId: 'live-session' } },
                sendCallback: async (msg) => console.log('[Agent] Live Tool Output:', msg), // No-op for direct response
                processMessage: agent.processMessage
            };

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
