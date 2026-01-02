const { Telegraf } = require('telegraf');
const axios = require('axios');
const { createUserMessage } = require('@deedee/shared/src/types');

class TelegramService {
  constructor(token, agentUrl) {
    this.bot = new Telegraf(token);
    this.agentUrl = agentUrl;

    // Security: Parse Allowed IDs
    const allowed = process.env.ALLOWED_TELEGRAM_IDS || '';
    this.allowedIds = new Set(allowed.split(',').map(id => id.trim()).filter(id => id.length > 0));

    if (this.allowedIds.size > 0) {
      console.log(`[Telegram] Security Enforced. Allowed IDs: ${Array.from(this.allowedIds).join(', ')}`);
    } else {
      console.warn(`[Telegram] ⚠️ WARNING: No ALLOWED_TELEGRAM_IDS set. Bot is PUBLIC.`);
    }

    this.bot.on('text', this.handleMessage.bind(this));
    this.bot.on('voice', this.handleVoice.bind(this));
  }

  _isAllowed(userId) {
    if (this.allowedIds.size === 0) return true; // Open by default if not configured
    return this.allowedIds.has(userId);
  }

  async start() {
    // Launch polling
    this.bot.launch(() => {
      console.log('Telegram Bot started polling.');
    });

    // Graceful stop
    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }

  async handleMessage(ctx) {
    try {
      const text = ctx.message.text;
      const userId = ctx.from.id.toString();

      if (!this._isAllowed(userId)) {
        console.warn(`[Telegram] Blocked message from unauthorized user: ${userId}`);
        return;
      }
      const chatId = ctx.chat.id.toString();

      console.log(`[Telegram] Received from ${userId}: ${text}`);

      const message = createUserMessage(text, 'telegram', userId);
      // Attach chatId to metadata so we know where to reply
      message.metadata = { chatId };

      // Forward to Agent
      await axios.post(`${this.agentUrl}/webhook`, message);

    } catch (error) {
      console.error('[Telegram] Error forwarding message:', error.message);
      ctx.reply('Sorry, I am having trouble reaching my brain.');
    }
  }

  async handleVoice(ctx) {
    try {
      const fileId = ctx.message.voice.file_id;
      const fileLink = await ctx.telegram.getFileLink(fileId);

      const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);
      const base64Audio = buffer.toString('base64');

      const userId = ctx.from.id.toString();

      if (!this._isAllowed(userId)) {
        console.warn(`[Telegram] Blocked voice from unauthorized user: ${userId}`);
        return;
      }
      const chatId = ctx.chat.id.toString();

      console.log(`[Telegram] Received voice from ${userId}`);

      // Create a message with parts
      const message = createUserMessage('[Voice]', 'telegram', userId);
      message.parts = [
        { text: "The user has received a voice message. Detect its language, listen to it and respond appropriately." },
        {
          inlineData: {
            mimeType: ctx.message.voice.mime_type || 'audio/ogg',
            data: base64Audio
          }
        }
      ];
      message.metadata = { chatId };

      // Forward to Agent
      await axios.post(`${this.agentUrl}/webhook`, message);

    } catch (error) {
      console.error('[Telegram] Error handling voice:', error.message);
      ctx.reply('Sorry, I am having trouble listening to your voice message.');
    }
  }

  async sendMessage(chatId, content) {
    try {
      // strict Markdown (MarkdownV2) often fails with unescaped characters from LLMs. 
      // Legacy 'Markdown' is more forgiving.
      await this.bot.telegram.sendMessage(chatId, content, { parse_mode: 'Markdown' });
    } catch (err) {
      console.warn('[Telegram] Failed to send Markdown, falling back to plain text:', err.message);
      // Fallback to plain text
      await this.bot.telegram.sendMessage(chatId, content);
    }
  }
}

module.exports = { TelegramService };
