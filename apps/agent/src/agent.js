const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createAssistantMessage } = require('@deedee/shared/src/types');
const { GSuiteTools } = require('@deedee/mcp-servers/src/gsuite/index');
const { LocalTools } = require('@deedee/mcp-servers/src/local/index');
const { AgentDB } = require('./db');
const { toolDefinitions } = require('./tools-definition');

class Agent {
  constructor(config) {
    this.interface = config.interface;
    this.genAI = new GoogleGenerativeAI(config.googleApiKey);
    
    // Persistence
    this.db = new AgentDB(); // Defaults to /app/data

    // Tools Setup
    this.gsuite = new GSuiteTools();
    this.local = new LocalTools('/app/source');
    
    const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-pro-latest';
    const apiVersion = process.env.GEMINI_API_VERSION || 'v1';
    console.log(`[Agent] Using model: ${modelName} (${apiVersion})`);
    
    this.model = this.genAI.getGenerativeModel({ 
      model: modelName, 
      apiVersion: apiVersion,
      tools: toolDefinitions 
    });
    this.chat = this.model.startChat();
    
    this.onMessage = this.onMessage.bind(this);
  }

  async start() {
    console.log('Agent starting...');
    
    // Check Goals
    const pendingGoals = this.db.getPendingGoals();
    if (pendingGoals.length > 0) {
      console.log(`[Memory] I have ${pendingGoals.length} pending goals.`);
      
      for (const goal of pendingGoals) {
        console.log(` - Resuming: ${goal.description}`);
        if (goal.metadata && goal.metadata.chatId) {
          const msg = createAssistantMessage(`I am back online. Resuming task: "${goal.description}"`);
          msg.metadata = { chatId: goal.metadata.chatId };
          // We need a slight delay or retry here in case Interfaces isn't ready, 
          // but for now we assume it is.
          this.interface.send(msg).catch(err => console.error('[Agent] Failed to send resume msg:', err));
        }
      }
    }

    this.interface.on('message', this.onMessage);
    console.log('Agent listening for messages.');
  }

  async onMessage(message) {
    try {
      console.log(`Received: ${message.content}`);
      
      // 1. Save User Message
      this.db.saveMessage(message);

      const result = await this.chat.sendMessage(message.content);
      const response = await result.response;
      
      const calls = response.functionCalls();
      if (calls && calls.length > 0) {
        const call = calls[0];
        console.log(`Function Call: ${call.name}`, call.args);
        
        let toolResult;
        // Memory
        if (call.name === 'rememberFact') {
          this.db.setKey(call.args.key, call.args.value);
          toolResult = { success: true };
        }
        else if (call.name === 'getFact') {
          toolResult = this.db.getKey(call.args.key);
        }
        else if (call.name === 'addGoal') {
          // Contextual Injection
          const metadata = { chatId: message.metadata?.chatId };
          const info = this.db.addGoal(call.args.description, metadata);
          toolResult = { success: true, id: info.lastInsertRowid };
        }
        else if (call.name === 'completeGoal') {
          this.db.completeGoal(call.args.id);
          toolResult = { success: true };
        }
        // GSuite
        else if (call.name === 'listEvents') toolResult = await this.gsuite.listEvents(call.args);
        else if (call.name === 'sendEmail') toolResult = await this.gsuite.sendEmail(call.args);
        // Local
        else if (call.name === 'readFile') toolResult = await this.local.readFile(call.args.path);
        else if (call.name === 'writeFile') toolResult = await this.local.writeFile(call.args.path, call.args.content);
        else if (call.name === 'listDirectory') toolResult = await this.local.listDirectory(call.args.path);
        else if (call.name === 'runShellCommand') toolResult = await this.local.runShellCommand(call.args.command);

        console.log('Tool Result:', toolResult);
        const nextResult = await this.chat.sendMessage([
          {
            functionResponse: {
              name: call.name,
              response: { result: toolResult }
            }
          }
        ]);
        
        const finalResponse = createAssistantMessage(nextResult.response.text());
        finalResponse.metadata = { chatId: message.metadata?.chatId };
        
        // 2. Save Assistant Reply
        this.db.saveMessage(finalResponse);
        
        await this.interface.send(finalResponse);

      } else {
        const text = response.text();
        const reply = createAssistantMessage(text);
        reply.metadata = { chatId: message.metadata?.chatId };
        
        // 2. Save Assistant Reply
        this.db.saveMessage(reply);
        
        await this.interface.send(reply);
      }
      
    } catch (error) {
      console.error('Error processing message:', error);
      const errReply = createAssistantMessage(`Error: ${error.message}`);
      errReply.metadata = { chatId: message.metadata?.chatId };
      await this.interface.send(errReply);
    }
  }
}

module.exports = { Agent };