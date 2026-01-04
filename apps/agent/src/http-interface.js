const axios = require('axios');
const EventEmitter = require('events');

class HttpInterface extends EventEmitter {
  /**
   * @param {string} interfacesUrl - e.g. 'http://interfaces:5000'
   */
  constructor(interfacesUrl) {
    super();
    this.interfacesUrl = interfacesUrl;
  }

  /**
   * Sends a message to the Interface Service.
   * @param {import('@deedee/shared/src/types').Message} message 
   */
  async send(message) {
    try {
      console.log(`[HttpInterface] Sending to ${message.source}...`);

      let content = message.content;
      let type = message.type || 'text';

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

      console.log(`[HttpInterface] DEBUG: Sending to ${message.source}, Type: ${type}, ChatID: ${message.metadata?.chatId}`);

      await axios.post(`${this.interfacesUrl}/send`, {
        source: message.source,
        content: content,
        metadata: message.metadata,
        type: type
      });
      console.log(`[HttpInterface] DEBUG: Successfully sent to Interfaces.`);
      return true;
    } catch (error) {
      console.error('[HttpInterface] Send Error:', error.message);
      return false;
    }
  }

  /**
   * Called by the Webhook Handler to inject a message from outside.
   * @param {import('@deedee/shared/src/types').Message} message 
   */
  receive(message) {
    this.emit('message', message);
  }
}

module.exports = { HttpInterface };
