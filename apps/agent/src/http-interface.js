const axios = require('axios');
const EventEmitter = require('events');

// A send that the interfaces service never answers fails after this long,
// so the delivery ledger can retry it (same id, so a repeat is deduped).
const SEND_TIMEOUT_MS = 120e3;
// What Deedee sent from the owner's own account, kept so an errand does not
// take it for his own writing. In memory: a restart forgets it.
const OWNER_SENDS_MAX = 500;
const OWNER_SENDS_MS = 8 * 24 * 3600e3;

class HttpInterface extends EventEmitter {
  /**
   * @param {string} interfacesUrl - e.g. 'http://interfaces:5000'
   */
  /**
   * @param {string} interfacesUrl - e.g. 'http://interfaces:5000'
   * @param {string} [apiToken] - Optional token for Authorization header
   */
  constructor(interfacesUrl, apiToken) {
    super();
    this.interfacesUrl = interfacesUrl;
    this.apiToken = apiToken || process.env.DEEDEE_API_TOKEN;
    this._ownerSends = [];
  }

  /**
   * Messages Deedee sent from the owner's own WhatsApp account (a job, a
   * greeting, an errand) to any of these chats: { id, text, at }. His own
   * typing is never here.
   * @param {string[]} ids - chat ids or their digits
   */
  ownerAccountSends(ids = []) {
    const wanted = new Set((ids || []).map(v => String(v ?? '').replace(/@.*$/, '').replace(/\D/g, '')).filter(d => d.length >= 6));
    return this._ownerSends.filter(e => wanted.has(e.chat)).map(({ id, text, at }) => ({ id, text, at }));
  }

  _rememberOwnerSend(chatId, content, messageId) {
    const chat = String(chatId ?? '').replace(/@.*$/, '').replace(/\D/g, '');
    if (!chat || typeof content !== 'string') return;
    const now = Date.now();
    this._ownerSends = this._ownerSends.filter(e => now - e.at < OWNER_SENDS_MS).slice(-(OWNER_SENDS_MAX - 1));
    this._ownerSends.push({ chat, text: content.trim(), id: messageId ? String(messageId) : null, at: now });
  }

  /**
   * Sends a message to the Interface Service.
   * @param {import('@deedee/shared/src/types').Message} message 
   */
  async send(message) {
    try {
      let content = message.content;
      let type = message.type || 'text';

      console.log(`[HttpInterface] Sending to ${message.source}...`);
      if (typeof content === 'string') {
        console.log(`[HttpInterface] Content-Type: ${type} | Preview: "${content.substring(0, 250)}${content.length > 250 ? '...' : ''}"`);
      } else {
        console.log(`[HttpInterface] Content-Type: ${type} | (Binary/Object)`);
      }

      // Check for audio/image parts (Gemini style)
      if (message.parts && message.parts.length > 0) {
        // Look for audio/wav or any audio
        const audioPart = message.parts.find(p => p.inlineData && p.inlineData.mimeType && p.inlineData.mimeType.startsWith('audio/'));
        const imagePart = message.parts.find(p => p.inlineData && p.inlineData.mimeType && p.inlineData.mimeType.startsWith('image/'));

        if (audioPart) {
          content = audioPart.inlineData.data; // Base64
          type = 'audio';
        } else if (imagePart) {
          content = imagePart.inlineData.data; // Base64
          type = 'image';
        }
      }

      let finalSource = message.source;
      const metadata = { ...message.metadata };

      // Handle Dual Session Source format (e.g. 'whatsapp:assistant')
      if (typeof finalSource === 'string' && finalSource.includes(':')) {
        const parts = finalSource.split(':');
        // If it's one of our known dual-session services
        if (parts[0] === 'whatsapp') {
          finalSource = parts[0];
          metadata.session = parts[1];
        }
      }

      const res = await axios.post(`${this.interfacesUrl}/send`, {
        // The message id travels with the send so a retry of the same message
        // (delivery ledger) is recognized and not sent twice.
        id: message.id || null,
        source: finalSource,
        content: content,
        metadata: metadata,
        type: type,
        caption: message.caption || null,
        isNotification: message.isNotification,
        platform: message.platform
      }, {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`
        },
        timeout: SEND_TIMEOUT_MS
      });
      // The WhatsApp id of what went out, on the caller's own object: an
      // errand tells its messages from the ones the owner types himself.
      // The return value stays a boolean for every other caller.
      if (res?.data?.messageId && message && typeof message === 'object') {
        // A frozen payload keeps no id, and the message still went out.
        try { message.sentMessageId = String(res.data.messageId); } catch { /* frozen or sealed */ }
      }
      if (finalSource === 'whatsapp' && metadata.session === 'user') this._rememberOwnerSend(metadata.chatId, content, res?.data?.messageId);
      return true;
    } catch (error) {
      console.error('[HttpInterface] Send Error:', error.message);
      return false;
    }
  }

  async sendProgress(chatId, status) {
    try {
      await axios.post(`${this.interfacesUrl}/progress`, { chatId, status }, {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`
        }
      });
    } catch (error) {
      // fire and forget
    }
  }

  /**
   * Broadcasts an event to all connected clients via the Interface Service.
   * @param {string} event - Event name (e.g., 'entity:update')
   * @param {Object} data - Event payload
   */
  async broadcast(event, data) {
    try {
      await axios.post(`${this.interfacesUrl}/broadcast`, { event, data }, {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`
        }
      });
      return true;
    } catch (error) {
      console.error('[HttpInterface] Broadcast Error:', error.message);
      return false;
    }
  }

  /**
   * Called by the Webhook Handler to inject a message from outside.
   * @param {import('@deedee/shared/src/types').Message} message 
   */
  receive(message) {
    // console.log(`[HttpInterface] Emitting 'message' event for ${message.source}`);
    this.emit('message', message);
  }
}

module.exports = { HttpInterface, SEND_TIMEOUT_MS };
