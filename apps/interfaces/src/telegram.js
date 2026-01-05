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

    this.activeTyping = new Map();
  }

  startTyping(chatId) {
    if (this.activeTyping.has(chatId)) return;

    // Send immediately
    this.bot.telegram.sendChatAction(chatId, 'typing').catch(() => { });

    // Loop every 4s (Telegram lasts 5s)
    const interval = setInterval(() => {
      this.bot.telegram.sendChatAction(chatId, 'typing').catch(() => { });
    }, 4000);

    // Auto-stop after 60s to prevent infinite loops if Agent crashes
    const timeout = setTimeout(() => {
      this.stopTyping(chatId);
    }, 60000);

    this.activeTyping.set(chatId, { interval, timeout });
  }

  stopTyping(chatId) {
    if (this.activeTyping.has(chatId)) {
      const { interval, timeout } = this.activeTyping.get(chatId);
      clearInterval(interval);
      clearTimeout(timeout);
      this.activeTyping.delete(chatId);
    }
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

      // Indicate we are thinking
      this.startTyping(chatId);

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

      // Indicate we are thinking
      this.startTyping(chatId);

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

  _escapeMarkdown(text) {
    // Escapes special characters for MarkdownV2
    // Characters to escape: _ * [ ] ( ) ~ ` > # + - = | { } . !
    return text.replace(/([_*\[\]()~`>#\+\-=|{}.!])/g, '\\$1');
  }

  async sendMessage(chatId, content) {
    this.stopTyping(chatId);
    try {
      // Heuristic: Split by code blocks (```) to escape text outside of them.
      const parts = content.split('```');
      let finalMsg = '';

      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0) {
          // Regular Text -> Escape
          finalMsg += this._escapeMarkdown(parts[i]);
        } else {
          // Code Block -> Keep raw, wrap in fences
          finalMsg += '```' + parts[i] + '```';
        }
      }

      await this.bot.telegram.sendMessage(chatId, finalMsg, { parse_mode: 'MarkdownV2' });

    } catch (err) {
      console.warn('[Telegram] Failed to send MarkdownV2, falling back to plain text:', err.message);
      // Fallback to plain text
      await this.bot.telegram.sendMessage(chatId, content);
    }
  }

  async sendVoice(chatId, content) {
    this.stopTyping(chatId);
    try {
      let source;
      if (content.startsWith('http')) {
        source = { url: content };
      } else {
        // Assume Base64
        source = {
          source: Buffer.from(content, 'base64'),
          filename: 'voice_message.wav'
        };
      }

      console.log(`[Telegram] Sending audio to ${chatId}`);
      await this.bot.telegram.sendAudio(chatId, source, {
        title: 'Audio Response',
        performer: 'Deedee'
      });
    } catch (err) {
      console.error('[Telegram] Failed to send voice:', err.message);
      await this.bot.telegram.sendMessage(chatId, "Sorry, I couldn't send the audio response.");
    }
  }

  async sendPhoto(chatId, content) {
    this.stopTyping(chatId);
    try {
      let source;
      if (content.startsWith('http')) {
        source = { url: content };
      } else {
        source = { source: Buffer.from(content, 'base64') };
      }

      console.log(`[Telegram] Sending photo to ${chatId}`);
      await this.bot.telegram.sendPhoto(chatId, source);
    } catch (err) {
      console.error('[Telegram] Failed to send photo:', err.message);
      await this.bot.telegram.sendMessage(chatId, "Sorry, I couldn't send the image.");
    }
  }
}

module.exports = { TelegramService };
