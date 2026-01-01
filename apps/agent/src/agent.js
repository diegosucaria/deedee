const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createAssistantMessage } = require('@deedee/shared/src/types');

class Agent {
  /**
   * @param {Object} config
   * @param {string} config.googleApiKey
   * @param {Object} config.interface - The generic interface adapter
   */
  constructor(config) {
    this.interface = config.interface;
    this.genAI = new GoogleGenerativeAI(config.googleApiKey);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-pro' });
    
    // Bind methods
    this.onMessage = this.onMessage.bind(this);
  }

  async start() {
    console.log('Agent starting...');
    // Listen to the interface
    this.interface.on('message', this.onMessage);
    console.log('Agent listening for messages.');
  }

  /**
   * Core Loop: Receive -> Think -> Reply
   * @param {import('@deedee/shared/src/types').Message} message 
   */
  async onMessage(message) {
    try {
      console.log(`Received: ${message.content}`);

      // 1. Generate Content
      const result = await this.model.generateContent(message.content);
      const response = await result.response;
      const text = response.text();

      // 2. Create Response Object
      const reply = createAssistantMessage(text);

      // 3. Send back through interface
      await this.interface.send(reply);
      
    } catch (error) {
      console.error('Error processing message:', error);
      // In a real app, send an error message back to user
    }
  }
}

module.exports = { Agent };
