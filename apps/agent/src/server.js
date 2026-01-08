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
// Note: We might want to persist the agent instance if it has state (it will have SQLite later)
let agent;
if (googleApiKey) {
  agent = new Agent({
    googleApiKey,
    interface: httpInterface
  });
  agent.start().catch(console.error);
} else {
  console.warn('[Agent] GOOGLE_API_KEY missing. Agent not started.');
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', initialized: !!agent });
});

app.post('/webhook', (req, res) => {
  const message = req.body;

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

const { createInternalRouter } = require('./routes/internal');
const { createLiveRouter } = require('./routes/live');
const { createToolRouter } = require('./routes/tools');
const { createSettingsRouter } = require('./routes/settings');

// ... (Agent instantiation code remains above)

// Mount Live Router (works without Agent instance for Config/Token)
app.use('/live', createLiveRouter(agent));

if (agent) {
  // Mount Modular Routers
  app.use('/internal/settings', createSettingsRouter(agent));
  app.use('/internal', createInternalRouter(agent));
  app.use('/', createToolRouter(agent)); // Mounts at root because it handles /tools/execute AND /internal/tools
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

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Agent listening at http://localhost:${port}`);
  });
}

module.exports = { app, agent };

