const { Server } = require("socket.io");
const http = require('http');
const express = require('express');
const { TelegramService } = require('./telegram');
const { WhatsAppService } = require('./whatsapp');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Adjust for production
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
io.on("connection", (socket) => {
  console.log(`[Interfaces] Socket connected: ${socket.id}`);

  // Forward client message to Agent
  socket.on("chat:message", async (data) => {
    // data: { content: "hello", source: "web" }
    try {
      console.log(`[Interfaces] Received socket message from ${socket.id}`);
      // Send to Agent
      const payload = {
        content: data.content,
        source: 'web',
        metadata: {
          chatId: data.chatId || socket.id,
          socketId: socket.id
        }
      };

      const response = await axios.post(`${agentUrl}/chat`, payload);

      console.log(`[Interfaces] Agent responded with ${response.data.replies?.length || 0} replies.`);

      if (response.data.replies && Array.isArray(response.data.replies)) {
        for (const reply of response.data.replies) {
          socket.emit('agent:message', {
            content: reply.content,
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
    console.log(`[Interfaces] Socket disconnected: ${socket.id}`);
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

app.post('/whatsapp/disconnect', async (req, res) => {
  if (isWhatsAppDisabled) return res.status(400).json({ error: 'WhatsApp disabled' });

  const { session } = req.body;
  const service = whatsappSessions[session];

  if (!service) return res.status(400).json({ error: 'Invalid session ID' });

  await service.disconnect();
  // Auto-restart to generate new QR
  setTimeout(() => service.start(), 1000);
  res.json({ success: true });
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

    res.status(400).json({ error: `Unsupported source or service not enabled: ${source}` });

  } catch (error) {
    console.error('[Interfaces] Send Error:', error);
    res.status(500).json({ error: error.message });
  }
});



// --- SESSION MANAGEMENT ---
app.get('/sessions', async (req, res) => {
  try {
    const { limit, offset } = req.query;
    const response = await axios.get(`${agentUrl}/internal/sessions`, { params: { limit, offset } });
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

if (require.main === module) {
  server.listen(port, () => {
    console.log(`Interfaces listening at http://localhost:${port}`);
  });
}

module.exports = { app };
