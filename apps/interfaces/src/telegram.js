const { Telegraf } = require('telegraf');
const axios = require('axios');
const { createUserMessage } = require('@deedee/shared/src/types');

class TelegramService {
  constructor(token, agentUrl) {
    this.bot = new Telegraf(token);
    this.agentUrl = agentUrl;

    this.bot.on('text', this.handleMessage.bind(this));
    this.bot.on('voice', this.handleVoice.bind(this));
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
      const chatId = ctx.chat.id.toString();

      console.log(`[Telegram] Received voice from ${userId}`);

      // Create a message with parts
      const message = createUserMessage('[Voz]', 'telegram', userId);
      message.parts = [
        { text: "El usuario ha enviado un mensaje de voz. Escúchalo y responde adecuadamente." },
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
      ctx.reply('Perdón, tuve un problema procesando tu mensaje de voz.');
    }
  }

  async sendMessage(chatId, content) {
    // strict Markdown (MarkdownV2) often fails with unescaped characters from LLMs. 
    // Legacy 'Markdown' is more forgiving.
    await this.bot.telegram.sendMessage(chatId, content, { parse_mode: 'Markdown' });
  }
}

module.exports = { TelegramService };
