const { Telegraf } = require('telegraf');
const axios = require('axios');
const { createUserMessage } = require('@deedee/shared/src/types');

class TelegramService {
  constructor(token, agentUrl) {
    this.bot = new Telegraf(token);
    this.agentUrl = agentUrl;

    this.bot.on('text', this.handleMessage.bind(this));
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

  async sendMessage(chatId, content) {
    await this.bot.telegram.sendMessage(chatId, content);
  }
}

module.exports = { TelegramService };
