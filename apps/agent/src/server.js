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

  if (!message || !message.content) {
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

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Agent listening at http://localhost:${port}`);
  });
}

module.exports = { app };
