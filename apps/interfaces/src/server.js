const { Server } = require("socket.io");
const http = require('http');
const express = require('express');
const { TelegramService } = require('./telegram');

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
      // We expect Agent to reply to /send, which we will route back to socket
      // But we need to pass a "chatId" that maps to this socket.
      // For web, use socket.id as chatId or a session ID.
      const payload = {
        content: data.content,
        source: 'web',
        metadata: {
          chatId: data.chatId || socket.id,
          socketId: socket.id
        }
      };

      // We use axios or fetch to call Agent
      // Wait, this file didn't require axios/fetch (only TelegramService used axios internally?)
      // Check imports. Line 13 of package.json has axios.
      const axios = require('axios');
      await axios.post(`${agentUrl}/v1/chat`, payload);

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

    // WEB / SOCKET
    if (source === 'web' || (metadata && metadata.socketId)) {
      // Ideally we use metadata.chatId (which might be the room) or metadata.socketId
      // We'll broadcast to the room (chatId) if we join rooms, or just to the specific socket if explicit.
      // Flexible: emit to chatId
      const target = metadata.chatId || metadata.socketId;
      if (target) {
        io.to(target).emit('agent:message', {
          content,
          type: type || 'text',
          timestamp: new Date().toISOString()
        });
        return res.json({ success: true });
      }
    }

    if (source === 'telegram' && telegram) {
      if (!metadata || !metadata.chatId) {
        throw new Error('Missing chatId in metadata for Telegram message');
      }

      if (type === 'audio') {
        // content is expected to be base64 string or url
        await telegram.sendVoice(metadata.chatId, content);
      } else {
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

if (require.main === module) {
  server.listen(port, () => {
    console.log(`Interfaces listening at http://localhost:${port}`);
  });
}

module.exports = { app };
