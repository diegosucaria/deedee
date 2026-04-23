const { Server } = require("socket.io");
const http = require('http');
const express = require('express');
const { TelegramService } = require('./telegram');
const { WhatsAppService } = require('./whatsapp');
const { SlackManager, SlackService } = require('./slack');
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

// Auth Middleware — two paths:
// 1. Token auth: internal services (agent, supervisor) send DEEDEE_API_TOKEN → trusted producer
// 2. Origin auth: browser clients come from an allowed origin (behind Traefik forward-auth)
// All other connections are rejected.
const ALLOWED_ORIGINS = (process.env.ALLOWED_SOCKET_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

io.use((socket, next) => {
  // Path 1: Token auth (internal services)
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (token && token === process.env.DEEDEE_API_TOKEN) {
    socket.isTrusted = true;
    console.log(`[Interfaces] Trusted producer connected: ${socket.id}`);
    return next();
  }

  // Path 2: Origin auth (browser clients behind forward-auth)
  const origin = socket.handshake.headers?.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    console.log(`[Interfaces] Browser client connected: ${socket.id} (origin: ${origin})`);
    return next();
  }

  console.warn(`[Interfaces] Rejected socket: ${socket.id} (origin: ${origin || 'none'}, token: ${token ? 'invalid' : 'none'})`);
  return next(new Error('authentication_error'));
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
      const errorMessage = err.response?.data?.error || err.message || 'Failed to process message';
      const targetChatId = data.chatId || socket.id;
      // Emit structured error to the frontend
      socket.emit('agent:error', {
        chatId: targetChatId,
        message: errorMessage,
        timestamp: new Date().toISOString()
      });
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
let slack = new SlackManager(agentUrl);
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

app.get('/whatsapp/resolve', (req, res) => {
  if (isWhatsAppDisabled) return res.json({ phoneJid: null, lid: null, name: null, allJids: [] });
  const { identifier, session } = req.query;
  if (!identifier) return res.status(400).json({ error: 'Missing identifier' });

  const targetSession = session || 'user';
  const service = whatsappSessions[targetSession];
  if (!service) return res.status(400).json({ error: 'Invalid session' });

  res.json(service.resolveIdentity(identifier));
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
  res.json({ connections: slack?.getStatus() || [] });
});

app.post('/slack/credentials', async (req, res) => {
  try {
    const { xoxc, xoxd, test } = req.body;
    if (!xoxc || !xoxd) return res.status(400).json({ error: 'Missing xoxc or xoxd token' });

    if (test) {
      const tempSlack = new SlackService(agentUrl, { xoxc, xoxd });
      await tempSlack.start();
      if (!tempSlack.workspace) return res.status(400).json({ error: 'Invalid tokens' });
      await tempSlack.stop();
      return res.json({ success: true, team: tempSlack.workspace.team, user: tempSlack.workspace.user });
    }

    const workspace = await slack.addConnection(xoxc, xoxd);
    io.emit('slack:status', slack.getStatus());
    res.json({ success: true, workspace });
  } catch (err) {
    console.error('[Interfaces] Slack credentials error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post('/slack/listening', (req, res) => {
  try {
    const { teamId, listening } = req.body;
    slack.setListening(teamId, listening === true);
    io.emit('slack:status', slack.getStatus());
    res.json({ success: true });
  } catch (err) {
    console.error('[Interfaces] Slack listening error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/slack/credentials/:teamId', async (req, res) => {
  try {
    await slack.removeConnection(req.params.teamId);
    io.emit('slack:status', slack.getStatus());
    res.json({ success: true });
  } catch (err) {
    console.error('[Interfaces] Slack disconnect error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/slack/search', async (req, res) => {
  try {
    const { query, limit, teamId } = req.query;
    if (!query) return res.status(400).json({ error: 'Missing query parameter' });
    const results = await slack.search(query, parseInt(limit) || 10, teamId);
    res.json({ results });
  } catch (err) {
    console.error('[Interfaces] Slack search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/slack/history', async (req, res) => {
  try {
    const { channel, limit, days_back, teamId } = req.query;
    if (!channel) return res.status(400).json({ error: 'Missing channel parameter' });
    const messages = await slack.getHistory(
      channel,
      parseInt(limit) || 20,
      days_back ? parseInt(days_back) : undefined,
      teamId
    );
    res.json({ messages });
  } catch (err) {
    console.error('[Interfaces] Slack history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/slack/history/monitored', async (req, res) => {
  try {
    const { days_back } = req.query;
    const historyText = await slack.getMonitoredChannelsHistory(days_back ? parseInt(days_back) : 1);
    res.json({ text: historyText });
  } catch (err) {
    console.error('[Interfaces] Slack monitored history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/slack/resolve-user', async (req, res) => {
  try {
    const { name, teamId } = req.query;
    if (!name) return res.status(400).json({ error: 'Missing name parameter' });
    const nameLower = name.toLowerCase();

    // Search across all connected workspaces (or a specific one)
    const connections = teamId
      ? [slack.resolveConnection(teamId)]
      : Array.from(slack.connections?.values?.() || []);

    const matches = [];
    for (const conn of connections) {
      if (!conn?.connected) continue;
      try {
        const users = await conn.getWorkspaceUsers();
        for (const user of users) {
          const realName = (user.name || '').toLowerCase();
          const displayName = (user.displayName || '').toLowerCase();
          const email = (user.email || '').toLowerCase();
          const userId = (user.id || '').toLowerCase();
          if (userId === nameLower ||
              realName === nameLower || displayName === nameLower ||
              realName.includes(nameLower) || displayName.includes(nameLower) ||
              email.startsWith(nameLower)) {
            matches.push({
              ...user,
              workspace: conn.workspace?.teamId,
              workspaceName: conn.workspace?.team,
              // Exact match scores higher
              exactMatch: userId === nameLower || realName === nameLower || displayName === nameLower,
            });
          }
        }
      } catch (err) {
        console.warn(`[Interfaces] Error resolving user in workspace ${conn.workspace?.teamId}:`, err.message);
      }
    }

    // Sort: exact matches first
    matches.sort((a, b) => (b.exactMatch ? 1 : 0) - (a.exactMatch ? 1 : 0));

    res.json({ matches, count: matches.length });
  } catch (err) {
    console.error('[Interfaces] Slack resolve-user error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/slack/users', async (req, res) => {
  try {
    const { teamId } = req.query;
    const conn = slack.resolveConnection(teamId);
    if (!conn.connected) return res.status(400).json({ error: 'Slack not connected' });
    const users = await conn.getWorkspaceUsers();
    res.json(users);
  } catch (err) {
    console.error('[Interfaces] Slack users error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/slack/channels', async (req, res) => {
  try {
    const { teamId } = req.query;
    const conn = slack.resolveConnection(teamId);
    if (!conn.connected) return res.status(400).json({ error: 'Slack not connected' });
    const channels = await conn.getChannels();
    res.json(channels);
  } catch (err) {
    console.error('[Interfaces] Slack channels error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/slack/monitored-channels', (req, res) => {
  try {
    const { teamId } = req.query;
    res.json(slack.getMonitoredChannels(teamId));
  } catch (err) {
    console.error('[Interfaces] Slack get monitored channels error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/slack/monitored-channels', (req, res) => {
  try {
    const { teamId, channels } = req.body;
    slack.setMonitoredChannels(teamId, channels);
    io.emit('slack:status', slack.getStatus());
    res.json({ success: true });
  } catch (err) {
    console.error('[Interfaces] Slack set monitored channels error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Removed GSuite routes

// Endpoint for Agent to send messages out
app.post('/send', async (req, res) => {
  try {
    const { source, content, metadata, type, caption } = req.body;
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
    if (source === 'scheduler' && !req.body.isNotification) {
      if (content.startsWith('Thinking...') || content.startsWith('Action **')) {
        return res.json({ success: true });
      }

      // External notifications are handled by Smart Notification logic in scheduler.js
      // We only log here to console
      console.log(`[Interfaces] Scheduler output: ${content}`);
      return res.json({ success: true });
    }

    // Treat 'scheduler' as the target platform if it's an explicit notification
    const actualSource = req.body.isNotification && source === 'scheduler' && req.body.platform ? req.body.platform : source;

    if (actualSource === 'telegram' && telegram) {
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

    if (actualSource === 'whatsapp') {
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

      const options = { type: type || 'text', caption: caption || null };
      await finalService.sendMessage(metadata.chatId, content, options);

      return res.json({ success: true });
    }

    if (actualSource === 'slack') {
      if (!slack?.connected) throw new Error('Slack not connected');
      if (!metadata?.chatId) throw new Error('Missing chatId in metadata for Slack message');
      await slack.sendMessage(metadata.chatId, content, { thread_ts: metadata.thread_ts });
      return res.json({ success: true });
    }

    res.status(400).json({ error: `Unsupported source or service not enabled: ${actualSource}` });

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
