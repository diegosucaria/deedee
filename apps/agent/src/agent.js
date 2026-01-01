const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createAssistantMessage } = require('@deedee/shared/src/types');
const { GSuiteTools } = require('@deedee/mcp-servers/src/gsuite/index');

class Agent {
  constructor(config) {
    this.interface = config.interface;
    this.genAI = new GoogleGenerativeAI(config.googleApiKey);
    
    // Tools Setup
    this.gsuite = new GSuiteTools();
    
    // Define Tools for Gemini
    const tools = [
      {
        functionDeclarations: [
          {
            name: "listEvents",
            description: "List calendar events for a time range",
            parameters: {
              type: "OBJECT",
              properties: {
                timeMin: { type: "STRING", description: "Start time (ISO string)" },
                timeMax: { type: "STRING", description: "End time (ISO string)" },
                maxResults: { type: "NUMBER" }
              }
            }
          },
          {
            name: "sendEmail",
            description: "Send an email to a recipient",
            parameters: {
              type: "OBJECT",
              properties: {
                to: { type: "STRING" },
                subject: { type: "STRING" },
                body: { type: "STRING" }
              },
              required: ["to", "subject", "body"]
            }
          }
        ]
      }
    ];

    this.model = this.genAI.getGenerativeModel({ model: 'gemini-pro', tools });
    this.chat = this.model.startChat(); // Maintain chat session
    
    this.onMessage = this.onMessage.bind(this);
  }

  async start() {
    console.log('Agent starting...');
    this.interface.on('message', this.onMessage);
    console.log('Agent listening for messages.');
  }

  async onMessage(message) {
    try {
      console.log(`Received: ${message.content}`);

      const result = await this.chat.sendMessage(message.content);
      const response = await result.response;
      
      // Check for Function Call
      const calls = response.functionCalls();
      if (calls && calls.length > 0) {
        const call = calls[0];
        console.log(`Function Call: ${call.name}`, call.args);
        
        // Execute Tool
        let toolResult;
        if (call.name === 'listEvents') {
          toolResult = await this.gsuite.listEvents(call.args);
        } else if (call.name === 'sendEmail') {
          toolResult = await this.gsuite.sendEmail(call.args);
        }

        // Send Result back to Model
        console.log('Tool Result:', toolResult);
        const nextResult = await this.chat.sendMessage([
          {
            functionResponse: {
              name: call.name,
              response: { result: toolResult }
            }
          }
        ]);
        
        // Final Text Response
        const finalResponse = createAssistantMessage(nextResult.response.text());
        finalResponse.metadata = { chatId: message.metadata?.chatId }; // Preserve context
        await this.interface.send(finalResponse);

      } else {
        // Plain Text Response
        const text = response.text();
        const reply = createAssistantMessage(text);
        reply.metadata = { chatId: message.metadata?.chatId };
        await this.interface.send(reply);
      }
      
    } catch (error) {
      console.error('Error processing message:', error);
      // Fallback reply
      const errReply = createAssistantMessage("I encountered an error processing that.");
      errReply.metadata = { chatId: message.metadata?.chatId };
      await this.interface.send(errReply);
    }
  }
}

module.exports = { Agent };