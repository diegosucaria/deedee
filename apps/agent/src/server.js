require('dotenv').config();
const express = require('express');
const { Agent } = require('./agent');
const { HttpInterface } = require('./http-interface');

const app = express();
const port = process.env.PORT || 3000;
const interfacesUrl = process.env.INTERFACES_URL || 'http://localhost:5000';
const googleApiKey = process.env.GOOGLE_API_KEY;

// Increase body limit to support large audio/image payloads
app.use(express.json({ limit: '50mb' }));

// Global Error Handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('[System] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[System] Uncaught Exception:', error);
  // Ideally, we should exit here, but in "YOLO" mode we try to stay up.
  // process.exit(1);
});

// 0. Environment & Secrets Setup
const fs = require('fs');
const path = require('path');

// Handle Base64 encoded Google Credentials (common in Balena/Container envs)
if (process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.GOOGLE_APPLICATION_CREDENTIALS.startsWith('/')) {
  try {
    console.log('[Setup] Detecting Base64/Content in GOOGLE_APPLICATION_CREDENTIALS...');
    const credsContent = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    let jsonContent;

    // Check if it's Base64
    if (/^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/.test(credsContent) && !credsContent.trim().startsWith('{')) {
      const buff = Buffer.from(credsContent, 'base64');
      jsonContent = buff.toString('utf-8');
    } else {
      // Assume it's raw JSON string
      jsonContent = credsContent;
    }

    // Validate it looks like JSON
    JSON.parse(jsonContent);

    // Write to file
    const credsPath = path.join('/tmp', 'google-service-account.json');

    fs.writeFileSync(credsPath, jsonContent);
    console.log(`[Setup] Wrote Google Credentials to ${credsPath}`);

    // Point SDK to the file
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credsPath;
  } catch (e) {
    console.error('[Setup] Failed to process GOOGLE_APPLICATION_CREDENTIALS content:', e.message);
    // Proceeding might fail if the SDK expects a path
  }
}

// 1. Setup Interface
const httpInterface = new HttpInterface(interfacesUrl);

// 2. Setup Agent
let agent;
try {
  if (googleApiKey) {
    console.log('[Server] Initializing Agent...');
    agent = new Agent({
      googleApiKey,
      interface: httpInterface
    });
    console.log('[Server] Agent initialized. Starting...');
    agent.start().catch(err => console.error('[Server] Agent start failed:', err));
  } else {
    console.warn('[Server] GOOGLE_API_KEY missing. Agent not started (Routes will not be mounted).');
  }
} catch (e) {
  console.error('[Server] Agent construction failed:', e);
}

// Debug Endpoint
app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    agentInitialized: !!agent,
    routesMounted: !!agent,
    env: {
      hasKey: !!googleApiKey,
      port
    }
  });
});



app.post('/webhook', (req, res) => {
  const message = req.body;

  if (message) {
    // console.log(`[Server] Webhook received message from ${message.source} (ChatID: ${message.metadata?.chatId})`);
  }

  if (!message || (!message.content && !message.parts)) {
    return res.status(400).json({ error: 'Invalid message format' });
  }

  // Inject into Agent
  if (agent) {
    // Normalize message fields
    message.role = message.role || 'user';
    message.source = message.source || 'http';
    message.timestamp = message.timestamp || new Date().toISOString();

    httpInterface.receive(message);
    res.json({ received: true });
  } else {
    res.status(503).json({ error: 'Agent not initialized' });
  }
});

// /internal/* routes carry private user content (wardrobe images, vault
// files, journal data, etc). Inside the Docker network they're already
// unreachable from the public internet, but we add a constant-time bearer
// check as defense-in-depth against accidental port exposure or a future
// deploy where agent isn't network-isolated. Web injects this token
// server-side when proxying to the agent; it never touches the browser.
const cryptoTimingSafe = require('crypto').timingSafeEqual;
const internalTokenMiddleware = (req, res, next) => {
    const expected = process.env.DEEDEE_INTERNAL_TOKEN;
    if (!expected) return next(); // Token unset: dev-only escape hatch.
    const header = req.headers.authorization || '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !cryptoTimingSafe(a, b)) {
        return res.status(401).json({ error: 'Invalid or missing internal token' });
    }
    next();
};

const { createInternalRouter } = require('./routes/internal');
const { createLiveRouter } = require('./routes/live');
const { createWatchersRouter } = require('./routes/watchers'); // NEW
const { createSkillsRouter } = require('./routes/skills'); // NEW
const { createToolRouter } = require('./routes/tools');
const { createSettingsRouter } = require('./routes/settings');
const createFilesRouter = require('./routes/files');
const createVaultRouter = require('./routes/vaults');

const { createPeopleRouter } = require('./routes/people');
const { createDjRouter } = require('./routes/dj');
const { createWardrobeRouter } = require('./routes/wardrobe');
const { createAutopilotRouter } = require('./routes/autopilot');
const { createNotificationsRouter } = require('./routes/notifications');

// Mount Live Router (works without Agent instance for Config/Token)
app.use('/live', createLiveRouter(agent));
const { createHealthRouter } = require('./routes/health');
app.use('/health', createHealthRouter(agent));

// Gate every /internal/* path with the bearer token check, regardless of
// whether agent is initialized. Express runs middleware in registration
// order, so this must come before any /internal route handlers.
app.use('/internal', internalTokenMiddleware);

if (agent) {
  // Mount Modular Routers
  app.use('/internal/skills', createSkillsRouter(agent));
  app.use('/internal/settings', createSettingsRouter(agent));
  app.use('/internal/watchers', createWatchersRouter(agent));
  app.use('/internal/people', createPeopleRouter(agent));
  app.use('/v1/chat', createFilesRouter(agent));
  app.use('/internal', createInternalRouter(agent));
  app.use('/v1/vaults', createVaultRouter(agent));
  app.use('/internal/dj', createDjRouter(agent));
  app.use('/internal/wardrobe', createWardrobeRouter(agent));
  app.use('/v1/autopilot', createAutopilotRouter(agent));
  app.use('/internal/notifications', createNotificationsRouter(agent));
  app.use('/', createToolRouter(agent));
}

app.post('/chat', async (req, res) => {
  const message = req.body;

  if (!message || (!message.content && !message.parts)) {
    return res.status(400).json({ error: 'Invalid message format' });
  }

  if (agent) {
    // Normalize message fields
    message.role = message.role || 'user';
    message.source = message.source || 'http';
    message.timestamp = message.timestamp || new Date().toISOString();

    const replies = [];
    try {
      const executionSummary = await agent.processMessage(message, async (reply) => {
        replies.push(reply);
      }, async (status) => {
        // Report progress to Interface Service
        if (message.metadata?.chatId) {
          httpInterface.sendProgress(message.metadata.chatId, status);
        }
      });

      // Use the captured 'replies' (from callbacks) as the source of truth for what to send back.
      // This ensures we respect:
      // 1. Tool-generated outputs (Audio/Image) which are sent via callback but not always in summary.
      // 2. Suppression logic (Text suppressed via callback is not in 'replies').
      let finalReplies = replies.length > 0 ? replies : (executionSummary?.replies || []);

      // Only filter strictly for the iOS Shortcut (source=iphone OR source=ios_shortcut)
      // This keeps "Thinking..." messages for other clients like Web Dashboards.
      if (['iphone', 'ios_shortcut'].includes(message.source)) {
        finalReplies = finalReplies.filter(r => {
          const c = r.content || '';
          return !c.startsWith('Thinking...') &&
            !c.startsWith('Still working...') &&
            !c.startsWith('Action **');
        });
      }

      res.json({
        replies: finalReplies,
        toolOutputs: executionSummary ? executionSummary.toolOutputs : []
      });
    } catch (error) {
      console.error('[Agent] Chat processing error:', error);
      res.status(500).json({ error: error.message });
    }
  } else {
    res.status(503).json({ error: 'Agent not initialized' });
  }
});

// Internal Management Endpoints
app.post('/internal/mcp/reload', async (req, res) => {
  if (!agent) return res.status(503).json({ error: 'Agent not initialized' });
  try {
    console.log('[Server] Reloading MCP Config...');
    if (agent.mcpManager) {
      await agent.mcpManager.init();
      res.json({ success: true });
    } else if (agent.mcp) {
      await agent.mcp.init();
      res.json({ success: true });
    } else {
      res.status(500).json({ error: 'MCP Manager not found on Agent' });
    }
  } catch (e) {
    console.error('[Server] Failed to reload MCP:', e);
    res.status(500).json({ error: e.message });
  }
});

// Internal MCP Config Management (Proxy Target)
app.get('/internal/mcp/config', async (req, res) => {
  if (!agent || !agent.mcp) return res.status(503).json({ error: 'Agent/MCP not ready' });
  try {
    const fs = require('fs');
    if (fs.existsSync(agent.mcp.configPath)) {
      res.json(JSON.parse(fs.readFileSync(agent.mcp.configPath, 'utf8')));
    } else {
      res.json({});
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/internal/mcp/config', async (req, res) => {
  if (!agent || !agent.mcp) return res.status(503).json({ error: 'Agent/MCP not ready' });
  try {
    const config = req.body;
    const fs = require('fs');
    fs.writeFileSync(agent.mcp.configPath, JSON.stringify(config, null, 2));
    // Reload
    await agent.mcp.init();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

if (require.main === module) {
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Agent listening at http://0.0.0.0:${port}`);
  });

  // Graceful Shutdown
  const shutdown = async () => {
    console.log('[Server] Shutting down...');
    if (agent) {
      await agent.stop();
    }
    server.close(() => {
      console.log('[Server] HTTP server closed.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { app, agent };

