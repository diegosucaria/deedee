const { Server } = require("socket.io");
const http = require('http');
const express = require('express');
const { TelegramService } = require('./telegram');
const { WhatsAppService } = require('./whatsapp');
const { SlackService } = require('./slack');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const corsOrigin = process.env.CORS_ORIGIN || '*';
const io = new Server(server, {
  maxHttpBufferSize: 5e7, // 50MB
  cors: {
    origin: corsOrigin === '*' ? '*' : corsOrigin.split(',').map(s => s.trim()),
    methods: ["GET", "POST"]
  }
});

const port = process.env.PORT || 5000;
const agentUrl = process.env.AGENT_URL || 'http://localhost:3000';
const telegramToken = process.env.TELEGRAM_TOKEN;
const allowedTelegramIds = (process.env.ALLOWED_TELEGRAM_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
const defaultTelegramId = allowedTelegramIds.length > 0 ? allowedTelegramIds[0] : null;

// Increase body limit to support base64 audio
app.use(express.json({ limit: '50mb' }));

// --- SOCKET.IO ---

// Auth Middleware to Identify Trusted Producers (Agent/Browser)
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (token && token === process.env.DEEDEE_API_TOKEN) {
    socket.isTrusted = true;
    console.log(`[Interfaces] Trusted Socket Connected: ${socket.id} (Agent/Browser)`);
  }
  next();
});

io.on("connection", (socket) => {
  const { chatId } = socket.handshake.query;
  // Reduce noise for frequent connect/disconnects if needed, or keep for debugging
  // console.log(`[Interfaces] Socket connected: ${socket.id} (ChatID: ${chatId || 'None'})`);

  if (chatId) {
    socket.join(chatId);
    console.log(`[Interfaces] Socket ${socket.id} joined room ${chatId}`);
  }

  // Handle Browser Screencast Frames (Relay)
  socket.on('browser:frame', (data) => {
    // SECURITY: Only allow trusted producers (Agent/Browser Layer) to emit frames
    if (!socket.isTrusted) {
      // Create a warning once per socket to avoid log spam? or just ignore.
      return;
    }

    // Broadcast to all clients (or specifically those watching?)
    // For now, broadcast global "browser:frame" to everyone.
    // data should contain { data: base64, timestamp: ... }
    io.emit('browser:frame', data);
  });

  // Forward client message to Agent
  socket.on("chat:message", async (data) => {
    // data: { content: "hello", source: "web" }
    try {
      console.log(`[Interfaces] Received socket message from ${socket.id}`);
      // Send to Agent
      const payload = {
        source: 'web',
        metadata: {
          chatId: data.chatId || socket.id,
          socketId: socket.id,
          ...data.metadata // Pass through everything (location, vaultId, etc)
        }
      };

      // Construct Multimodal Parts
      if (data.files && Array.isArray(data.files) && data.files.length > 0) {
        const parts = [];

        // 1. Text Part
        if (data.content) {
          parts.push({ text: data.content });
        }

        // 2. File Parts
        for (const file of data.files) {
          if (file.data && file.mimeType) {
            parts.push({
              inlineData: {
                mimeType: file.mimeType,
                data: file.data
              }
            });
          }
        }
        payload.parts = parts;
      } else {
        // Text Only
        payload.content = data.content;
      }

      const response = await axios.post(`${agentUrl}/chat`, payload);

      console.log(`[Interfaces] Agent responded with ${response.data.replies?.length || 0} replies.`);

      if (response.data.replies && Array.isArray(response.data.replies)) {
        for (const reply of response.data.replies) {
          socket.emit('agent:message', {
            content: reply.content,
            parts: reply.parts, // Forward parts (audio/images)
            type: reply.type || 'text',
            timestamp: reply.timestamp
          });
        }
      }

      // Ack to client?
      socket.emit("chat:ack", { id: data.id, status: "sent" });

    } catch (err) {
      console.error('[Interfaces] Socket Forward Error:', err.message);
      socket.emit("error", { message: "Failed to forward to agent" });
    }
  });

  socket.on("disconnect", () => {
    // console.log(`[Interfaces] Socket disconnected: ${socket.id}`);
  });
});

let telegram;
let whatsapp;

// Only start Telegram if token is present (prevents crash in tests/dev if missing)
if (telegramToken) {
  telegram = new TelegramService(telegramToken, agentUrl);
  telegram.start().catch(console.error);
} else {
  console.warn('[Interfaces] No TELEGRAM_TOKEN provided. Telegram disabled.');
}

// WhatsApp Init
// Enabled by default. To disable, set ENABLE_WHATSAPP=false explicitly if needed.
const isWhatsAppDisabled = process.env.ENABLE_WHATSAPP === 'false';
const whatsappSessions = {};

if (!isWhatsAppDisabled) {
  whatsappSessions.assistant = new WhatsAppService(agentUrl, 'assistant');
  whatsappSessions.user = new WhatsAppService(agentUrl, 'user');

  // Start both
  Object.values(whatsappSessions).forEach(ws => ws.start().catch(console.error));
} else {
  console.log('[Interfaces] WhatsApp explicitly disabled.');
}

// Slack Init
let slack = new SlackService(agentUrl);
slack.start().catch(err => console.error('[Interfaces] Slack init error:', err.message));

// Authentication Middleware
const authMiddleware = (req, res, next) => {
  // Skip auth for health check
  if (req.path === '/health') return next();

  const token = req.headers.authorization?.split(' ')[1];
  if (token !== process.env.DEEDEE_API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

app.use(authMiddleware);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    services: {
      telegram: !!telegram,
      whatsapp: Object.keys(whatsappSessions).length > 0,
      slack: slack?.getStatus()?.connected || false,
      socket: true
    }
  });
});

// --- WHATSAPP ENDPOINTS ---
app.get('/whatsapp/status', (req, res) => {
  if (isWhatsAppDisabled) return res.json({ status: 'disabled' });

  const status = {};
  for (const [key, service] of Object.entries(whatsappSessions)) {
    status[key] = service.getStatus();
  }
  res.json(status);
});

app.get('/whatsapp/contacts', (req, res) => {
  if (isWhatsAppDisabled) return res.json([]);

  const { session, query } = req.query;
  const targetSession = session || 'user';
  const service = whatsappSessions[targetSession];

  if (!service) {
    if (!res.headersSent) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }
    return;
  }

  if (query) {
    return res.json(service.searchContacts(query));
  }

  return res.json(service.getContacts());
});

app.get('/whatsapp/contact', (req, res) => {
  if (isWhatsAppDisabled) return res.json(null);
  const { session, jid } = req.query;
  if (!jid) return res.status(400).json({ error: 'Missing jid' });

  const targetSession = session || 'user';
  const service = whatsappSessions[targetSession];

  if (!service) return res.status(400).json({ error: 'Invalid session' });

  return res.json(service.getContact(jid));
});

app.get('/whatsapp/recent', (req, res) => {
  if (isWhatsAppDisabled) return res.json([]);
  const { session, limit } = req.query;
  const targetSession = session || 'user'; // Default to user for history checking?
  // Usually history for 'learning' comes from 'user' session? Or 'assistant'?
  // If 'user' session acts as the mirror of user's phone, it has the history.
  // 'assistant' session only has history of meaningful chats with assistant.
  // Smart Learn usually targets 'user' session history if available (User mirroring), 
  // or 'assistant' if it's just a bot. 
  // Given "Dual Session" architecture, we probably want 'user' (the real WhatsApp account mirroring) 
  // or fallback to 'assistant'. The query param handles it.

  const service = whatsappSessions[targetSession];
  if (!service) return res.status(400).json({ error: 'Invalid session' });

  const l = parseInt(limit) || 10;
  res.json(service.getRecentChats(l));
});

app.get('/whatsapp/history', (req, res) => {
  if (isWhatsAppDisabled) return res.json([]);
  const { session, jid, limit } = req.query;
  if (!jid) return res.status(400).json({ error: 'Missing jid' });

  const targetSession = session || 'user';
  const service = whatsappSessions[targetSession];
  if (!service) return res.status(400).json({ error: 'Invalid session' });

  const l = parseInt(limit) || 200;
  res.json(service.getChatHistory(jid, l));
});

app.get('/whatsapp/global-history', (req, res) => {
  if (isWhatsAppDisabled) return res.json([]);
  const { session, limit } = req.query;

  // Default to 'user' because we want to learn from the user's sent messages
  const targetSession = session || 'user';
  const service = whatsappSessions[targetSession];
  if (!service) return res.status(400).json({ error: 'Invalid session' });

  const l = parseInt(limit) || 500;
  res.json(service.getGlobalUserHistory(l));
});

app.get('/whatsapp/profile', async (req, res) => {
  if (isWhatsAppDisabled) return res.json({ url: null });
  const { session, jid } = req.query;
  if (!jid) return res.status(400).json({ error: 'Missing jid' });

  const targetSession = session || 'user';
  const service = whatsappSessions[targetSession];
  if (!service) return res.status(400).json({ error: 'Invalid session' });

  const url = await service.getProfilePicture(jid);
  res.json({ url });
});

app.post('/whatsapp/connect', async (req, res) => {
  if (isWhatsAppDisabled) return res.status(400).json({ error: 'WhatsApp disabled' });

  const { session } = req.body; // 'assistant' or 'user'
  console.log(`[Interfaces] Connect request for session: '${session}'. Body:`, JSON.stringify(req.body));
  const service = whatsappSessions[session];

  if (!service) {
    if (!res.headersSent) {
      console.error(`[Interfaces] Invalid session ID '${session}'. Available: ${Object.keys(whatsappSessions).join(', ')}`);
      return res.status(400).json({ error: 'Invalid session ID' });
    }
    return;
  }

  await service.connect();
  res.json({ success: true, message: `Connecting ${session}...` });
});

app.post('/whatsapp/diagnose', async (req, res) => {
  if (isWhatsAppDisabled) return res.status(400).json({ error: 'WhatsApp disabled' });

  const { session } = req.body;
  const targetSession = session || 'user';
  const service = whatsappSessions[targetSession];

  if (!service) return res.status(400).json({ error: 'Invalid session ID' });

  try {
    const report = await service.runDiagnostics();
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/whatsapp/disconnect', async (req, res) => {
  if (isWhatsAppDisabled) return res.status(400).json({ error: 'WhatsApp disabled' });

  const { session } = req.body;
  const service = whatsappSessions[session];

  if (!service) return res.status(400).json({ error: 'Invalid session ID' });

  await service.disconnect(true); // Explicitly clear session on manual disconnect
  // Auto-restart to generate new QR
  setTimeout(() => service.start(), 1000);
});

app.post('/whatsapp/repair', async (req, res) => {
  if (isWhatsAppDisabled) return res.status(400).json({ error: 'WhatsApp disabled' });

  const { session } = req.body;
  const targetSession = session || 'user';
  const service = whatsappSessions[targetSession];

  if (!service) return res.status(400).json({ error: 'Invalid session ID' });

  try {
    const result = await service.repairSession();
    res.json(result);
  } catch (err) {
    console.error('[Interfaces] Repair Status Failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- SLACK ENDPOINTS ---
app.get('/slack/status', (req, res) => {
  res.json(slack?.getStatus() || { connected: false });
});

app.post('/slack/credentials', async (req, res) => {
  try {
    const { xoxc, xoxd, test } = req.body;
    if (!xoxc || !xoxd) return res.status(400).json({ error: 'Missing xoxc or xoxd token' });

    if (test) {
      // Test mode: validate without saving
      const tempSlack = new SlackService(agentUrl);
      tempSlack.xoxc = xoxc;
      tempSlack.xoxd = xoxd;
      const auth = await tempSlack._api('auth.test');
      return res.json({ success: true, team: auth.team, user: auth.user });
    }

    const result = await slack.setCredentials(xoxc, xoxd);
    io.emit('slack:status', slack.getStatus());
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Interfaces] Slack credentials error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.delete('/slack/credentials', (req, res) => {
  slack.clearCredentials();
  io.emit('slack:status', slack.getStatus());
  res.json({ success: true });
});

app.get('/slack/search', async (req, res) => {
  try {
    const { query, limit } = req.query;
    if (!query) return res.status(400).json({ error: 'Missing query parameter' });
    const results = await slack.search(query, parseInt(limit) || 10);
    res.json({ results });
  } catch (err) {
    console.error('[Interfaces] Slack search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/slack/history', async (req, res) => {
  try {
    const { channel, limit } = req.query;
    if (!channel) return res.status(400).json({ error: 'Missing channel parameter' });
    const messages = await slack.getHistory(channel, parseInt(limit) || 20);
    res.json({ messages });
  } catch (err) {
    console.error('[Interfaces] Slack history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- GSUITE ENDPOINTS ---
app.get('/gsuite/accounts', async (req, res) => {
  try {
    const response = await axios.get(`${agentUrl}/internal/gsuite/accounts`);
    res.json(response.data);
  } catch (err) {
    console.error('[Interfaces] GSuite accounts error:', err.message);
    res.status(502).json({ error: 'Backend unavailable' });
  }
});

app.post('/gsuite/auth-url', async (req, res) => {
  try {
    const response = await axios.post(`${agentUrl}/internal/gsuite/auth-url`);
    res.json(response.data);
  } catch (err) {
    console.error('[Interfaces] GSuite auth-url error:', err.message);
    res.status(502).json({ error: 'Backend unavailable' });
  }
});

app.post('/gsuite/auth', async (req, res) => {
  try {
    const response = await axios.post(`${agentUrl}/internal/gsuite/auth`, req.body);
    res.json(response.data);
  } catch (err) {
    console.error('[Interfaces] GSuite auth error:', err.message);
    res.status(502).json({ error: 'Backend unavailable' });
  }
});

app.post('/gsuite/disconnect', async (req, res) => {
  try {
    const response = await axios.post(`${agentUrl}/internal/gsuite/disconnect`, req.body);
    res.json(response.data);
  } catch (err) {
    console.error('[Interfaces] GSuite disconnect error:', err.message);
    res.status(502).json({ error: 'Backend unavailable' });
  }
});

// Endpoint for Agent to send messages out
app.post('/send', async (req, res) => {
  try {
    const { source, content, metadata, type } = req.body;
    console.log(`[Interfaces] /send called. Source: ${source}, Type: ${type}, Meta:`, JSON.stringify(metadata));

    // WEB / SOCKET
    if (source === 'web' || (metadata && metadata.socketId)) {
      const target = metadata.chatId || metadata.socketId;
      console.log(`[Interfaces] DEBUG: Emitting to target: ${target}`);

      if (target) {
        if (type === 'session_update') {
          // Special event for session updates (title change)
          io.to(target).emit('session:update', JSON.parse(content));
          return res.json({ success: true });
        }

        io.to(target).emit('agent:message', {
          content,
          type: type || 'text',
          timestamp: new Date().toISOString()
        });
        return res.json({ success: true });
      }
    }

    // SCHEDULER (Internal)
    if (source === 'scheduler') {
      if (content.startsWith('Thinking...') || content.startsWith('Action **')) {
        return res.json({ success: true });
      }

      if (telegram && defaultTelegramId) {
        await telegram.sendMessage(defaultTelegramId, `📅 *Scheduled Task Update*\n\n${content}`);
      } else {
        console.log(`[Interfaces] Scheduler output: ${content}`);
      }
      return res.json({ success: true });
    }

    if (source === 'telegram' && telegram) {
      if (!metadata || !metadata.chatId) {
        throw new Error('Missing chatId in metadata for Telegram message');
      }

      if (type === 'audio') {
        await telegram.sendVoice(metadata.chatId, content);
      } else if (type === 'image') {
        await telegram.sendPhoto(metadata.chatId, content);
      } else {
        await telegram.sendMessage(metadata.chatId, content);
      }

      return res.json({ success: true });
    }

    if (source === 'whatsapp') {
      // Determine which session to use
      // metadata.session should be 'assistant' or 'user' if set by tool
      // Default to 'assistant' if not specified, OR if coming from a reply to 'assistant' session?
      // When we receive a message in whatsapp.js, we put session in metadata.
      // So if this is a reply, metadata.session should be present.

      const targetSessionId = metadata?.session || 'assistant';
      const service = whatsappSessions[targetSessionId];

      if (!service) {
        console.warn(`[Interfaces] WhatsApp session '${targetSessionId}' not found. Falling back to assistant.`);
      }

      // Final fallback
      const finalService = service || whatsappSessions.assistant;

      if (!finalService) {
        throw new Error('No WhatsApp service available');
      }

      if (!metadata || !metadata.chatId) {
        throw new Error('Missing chatId in metadata for WhatsApp message');
      }

      const options = { type: type || 'text' };
      await finalService.sendMessage(metadata.chatId, content, options);

      return res.json({ success: true });
    }

    if (source === 'slack') {
      if (!slack?.connected) throw new Error('Slack not connected');
      if (!metadata?.chatId) throw new Error('Missing chatId in metadata for Slack message');
      await slack.sendMessage(metadata.chatId, content, { thread_ts: metadata.thread_ts });
      return res.json({ success: true });
    }

    res.status(400).json({ error: `Unsupported source or service not enabled: ${source}` });

  } catch (error) {
    console.error('[Interfaces] Send Error:', error);
    res.status(500).json({ error: error.message });
  }
});



// --- SESSION MANAGEMENT ---
app.get('/sessions', async (req, res) => {
  try {
    const { limit, offset, preserveId } = req.query;
    const response = await axios.get(`${agentUrl}/internal/sessions`, { params: { limit, offset, preserveId } });
    res.json(response.data.sessions);
  } catch (err) {
    console.error('[Interfaces] Failed to get sessions:', err.message);
    res.status(502).json({ error: 'Backend unavailable' });
  }
});

app.post('/sessions', async (req, res) => {
  try {
    const response = await axios.post(`${agentUrl}/internal/sessions`, req.body);
    res.json(response.data);
  } catch (err) {
    console.error('[Interfaces] Failed to create session:', err.message);
    res.status(502).json({ error: 'Backend unavailable' });
  }
});

app.get('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch Metadata
    const sessionRes = await axios.get(`${agentUrl}/internal/sessions/${id}`);

    // Fetch History
    const historyRes = await axios.get(`${agentUrl}/internal/history`, { params: { chatId: id, limit: 100 } });

    res.json({
      ...sessionRes.data,
      messages: historyRes.data.history
    });
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return res.status(404).json({ error: 'Session not found' });
    }
    console.error('[Interfaces] Failed to get session details:', err.message);
    res.status(502).json({ error: 'Backend unavailable' });
  }
});

app.put('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await axios.put(`${agentUrl}/internal/sessions/${id}`, req.body);
    res.json({ success: true });
  } catch (err) {
    console.error('[Interfaces] Failed to update session:', err.message);
    res.status(502).json({ error: 'Backend unavailable' });
  }
});

app.delete('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await axios.delete(`${agentUrl}/internal/sessions/${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[Interfaces] Failed to delete session:', err.message);
    res.status(502).json({ error: 'Backend unavailable' });
  }
});

// --- DJ API ---


// Endpoint for Agent to report progress (e.g. "Routing...", "Thinking...")
app.post('/progress', async (req, res) => {
  try {
    const { chatId, status } = req.body;
    console.log(`[Interfaces] Progress Update for ${chatId}: ${status}`);

    if (chatId) {
      io.to(chatId).emit('agent:thinking', {
        status: status,
        timestamp: new Date().toISOString()
      });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('[Interfaces] Progress Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint for Agent to broadcast events to all clients
app.post('/broadcast', (req, res) => {
  try {
    const { event, data } = req.body;
    // Suppress noisy token logs
    if (event !== 'agent:token') {
      console.log(`[Interfaces] Broadcasting event: ${event}`);
    }

    if (event) {
      io.emit(event, data);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('[Interfaces] Broadcast Error:', error);
    res.status(500).json({ error: error.message });
  }
});

if (require.main === module) {
  server.listen(port, () => {
    console.log(`Interfaces listening at http://localhost:${port}`);
  });
}

module.exports = { app };
