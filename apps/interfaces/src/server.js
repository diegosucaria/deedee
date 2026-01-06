const { Server } = require("socket.io");
const http = require('http');
const express = require('express');
const { TelegramService } = require('./telegram');
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

// Only start Telegram if token is present (prevents crash in tests/dev if missing)
if (telegramToken) {
  telegram = new TelegramService(telegramToken, agentUrl);
  telegram.start().catch(console.error);
} else {
  console.warn('[Interfaces] No TELEGRAM_TOKEN provided. Telegram disabled.');
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', services: { telegram: !!telegram, socket: true } });
});

// Endpoint for Agent to send messages out
app.post('/send', async (req, res) => {
  try {
    const { source, content, metadata, type } = req.body;
    console.log(`[Interfaces] DEBUG: /send called. Source: ${source}, Type: ${type}, Meta:`, JSON.stringify(metadata));

    // WEB / SOCKET
    if (source === 'web' || (metadata && metadata.socketId)) {
      // Ideally we use metadata.chatId (which might be the room) or metadata.socketId
      // We'll broadcast to the room (chatId) if we join rooms, or just to the specific socket if explicit.
      // Flexible: emit to chatId
      const target = metadata.chatId || metadata.socketId;
      console.log(`[Interfaces] DEBUG: Emitting to target: ${target}`);

      if (target) {
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
      // Suppress "Thinking..." interim messages for notifications
      if (content.startsWith('Thinking...') || content.startsWith('Action **')) {
        console.log(`[Interfaces] Scheduler output (suppressed): ${content}`);
        return res.json({ success: true });
      }

      if (telegram && defaultTelegramId) {
        console.log(`[Interfaces] Scheduler output: Routing to default Telegram ID (${defaultTelegramId}): ${content}`);
        await telegram.sendMessage(defaultTelegramId, `📅 *Scheduled Task Update*\n\n${content}`);
      } else {
        console.log(`[Interfaces] Scheduler output (logged only): ${content}`);
      }
      return res.json({ success: true });
    }

    if (source === 'telegram' && telegram) {
      if (!metadata || !metadata.chatId) {
        throw new Error('Missing chatId in metadata for Telegram message');
      }

      if (type === 'audio') {
        // content is expected to be base64 string or url
        console.log(`[Interfaces] Sending Voice to ${metadata.chatId}`);
        await telegram.sendVoice(metadata.chatId, content);
      } else if (type === 'image') {
        console.log(`[Interfaces] Sending Photo to ${metadata.chatId}`);
        await telegram.sendPhoto(metadata.chatId, content);
      } else {
        console.log(`[Interfaces] Sending Text to ${metadata.chatId}: ${content.substring(0, 100).replace(/\n/g, ' ')}${content.length > 100 ? '...' : ''}`);
        await telegram.sendMessage(metadata.chatId, content);
      }

      return res.json({ success: true });
    }

    res.status(400).json({ error: `Unsupported source or service not enabled: ${source}` });

  } catch (error) {
    console.error('[Interfaces] Send Error:', error);
    res.status(500).json({ error: error.message });
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
