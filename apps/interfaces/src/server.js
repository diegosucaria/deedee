const express = require('express');
const { TelegramService } = require('./telegram');

const app = express();
const port = process.env.PORT || 5000;
const agentUrl = process.env.AGENT_URL || 'http://localhost:3000';
const telegramToken = process.env.TELEGRAM_TOKEN;

app.use(express.json());

let telegram;

// Only start Telegram if token is present (prevents crash in tests/dev if missing)
if (telegramToken) {
  telegram = new TelegramService(telegramToken, agentUrl);
  telegram.start().catch(console.error);
} else {
  console.warn('[Interfaces] No TELEGRAM_TOKEN provided. Telegram disabled.');
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', services: { telegram: !!telegram } });
});

// Endpoint for Agent to send messages out
app.post('/send', async (req, res) => {
  try {
    const { source, content, metadata } = req.body;

    if (source === 'telegram' && telegram) {
      if (!metadata || !metadata.chatId) {
        throw new Error('Missing chatId in metadata for Telegram message');
      }
      await telegram.sendMessage(metadata.chatId, content);
      return res.json({ success: true });
    }

    res.status(400).json({ error: `Unsupported source or service not enabled: ${source}` });

  } catch (error) {
    console.error('[Interfaces] Send Error:', error);
    res.status(500).json({ error: error.message });
  }
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Interfaces listening at http://localhost:${port}`);
  });
}

module.exports = { app };
