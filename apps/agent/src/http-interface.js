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
      await axios.post(`${this.interfacesUrl}/send`, {
        source: message.source,
        content: message.content,
        metadata: message.metadata,
        type: message.type || 'text'
      });
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
