const { GoogleGenAI } = require('@google/genai');
const { createAssistantMessage } = require('@deedee/shared/src/types');
const { GSuiteTools } = require('@deedee/mcp-servers/src/gsuite/index');
const { LocalTools } = require('@deedee/mcp-servers/src/local/index');
const { AgentDB } = require('./db');
const { toolDefinitions } = require('./tools-definition');

class Agent {
  constructor(config) {
    this.interface = config.interface;

    // 1. Initialize the unified Client
    this.client = new GoogleGenAI({ apiKey: config.googleApiKey });

    // Persistence
    this.db = new AgentDB(); // Defaults to /app/data

    // Tools Setup
    this.gsuite = new GSuiteTools();
    this.local = new LocalTools('/app/source');

    this.modelName = process.env.GEMINI_MODEL || 'gemini-1.5-pro';
    const apiVersion = process.env.GEMINI_API_VERSION || 'v1beta';

    console.log(`[Agent] Using model: ${this.modelName} (Client version: ${apiVersion})`);

    // 2. Start Chat (happens on the client, not a model instance)
    // Note: If you have system instructions, they go into 'config' here as well.
    this.chat = this.client.chats.create({
      model: this.modelName,
      config: {
        tools: toolDefinitions,
      }
    });

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


      // Feature: Rate Limiting
      // default: 50 msg/hour, 500 msg/day
      const limitHourly = parseInt(process.env.RATE_LIMIT_HOURLY || '50');
      const limitDaily = parseInt(process.env.RATE_LIMIT_DAILY || '500');

      const usedHour = this.db.checkLimit(1);
      const usedDay = this.db.checkLimit(24);

      if (usedHour >= limitHourly || usedDay >= limitDaily) {
        console.warn(`[Agent] Rate limit exceeded. Hour: ${usedHour}/${limitHourly}, Day: ${usedDay}/${limitDaily}`);
        const limitReply = createAssistantMessage(`⚠️ Rate limit exceeded. please try again later.`);
        limitReply.metadata = { chatId: message.metadata?.chatId };
        limitReply.source = message.source;
        await this.interface.send(limitReply);
        return;
      }

      // Log current usage
      this.db.logUsage();


      // 1. Save User Message
      this.db.saveMessage(message);

      // 2. Send Message to Gemini
      let response = await this.chat.sendMessage({ message: message.content });

      // 3. Handle Function Calls Loop
      let functionCalls = this._getFunctionCalls(response);

      if (functionCalls.length > 0) {
        const thinkingMsg = createAssistantMessage('Thinking...');
        thinkingMsg.metadata = { chatId: message.metadata?.chatId };
        thinkingMsg.source = message.source;
        await this.interface.send(thinkingMsg).catch(err => console.error('[Agent] Failed to send thinking msg:', err));
      }

      const MAX_LOOPS = parseInt(process.env.MAX_TOOL_LOOPS || '10');
      let loopCount = 0;

      while (functionCalls && functionCalls.length > 0) {
        loopCount++;
        if (loopCount > MAX_LOOPS) {
          console.warn(`[Agent] Max tool loop limit reached (${MAX_LOOPS}). Breaking.`);
          await this.interface.send(createAssistantMessage('I am stuck in a loop. Stopping now.'));
          break;
        }

        const call = functionCalls[0];
        console.log(`Function Call: ${call.name}`, call.args);

        let toolResult;
        // Memory
        if (call.name === 'rememberFact') {
          this.db.setKey(call.args.key, call.args.value);
          toolResult = { success: true };
        }
        else if (call.name === 'getFact') {
          const val = this.db.getKey(call.args.key);
          toolResult = val ? { value: val } : { info: 'Fact not found in database.' };
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
        // Supervisor
        else if (call.name === 'rollbackLastChange') {
          // Trigger Supervisor Rollback
          const rollbackRes = await fetch(`${process.env.SUPERVISOR_URL || 'http://supervisor:4000'}/cmd/rollback`, {
            method: 'POST'
          });
          toolResult = await rollbackRes.json();
        }

        if (toolResult === undefined || toolResult === null) {
          toolResult = { info: 'No output from tool execution.' };
        }

        console.log('Tool Result:', toolResult);

        // Send Tool Response back to Gemini
        response = await this.chat.sendMessage({
          message: [{
            functionResponse: {
              name: call.name,
              response: { result: toolResult }
            }
          }]
        });

        // Re-check for recursive function calls (e.g., tool calls another tool)
        functionCalls = this._getFunctionCalls(response);
      }

      // 4. Final Text Response
      const text = response.text || '';

      if (text) {
        if (message.source === 'http') {
          console.log('[Agent] Final Response (to console):', text);
        } else {
          const reply = createAssistantMessage(text);
          reply.metadata = { chatId: message.metadata?.chatId };
          reply.source = message.source; // Ensure reply source matches incoming message source

          // 2. Save Assistant Reply
          this.db.saveMessage(reply);

          await this.interface.send(reply);
        }
      }

    } catch (error) {
      console.error('Error processing message:', error);
      const errReply = createAssistantMessage(`Error: ${error.message}`);
      errReply.metadata = { chatId: message.metadata?.chatId };
      errReply.source = message.source;
      await this.interface.send(errReply);
    }
  }

  // Helper to extract function calls from the new SDK response structure
  _getFunctionCalls(response) {
    const candidates = response.candidates;
    if (!candidates || !candidates.length) return [];

    // Flatten parts from the first candidate that are function calls
    return candidates[0].content.parts
      .filter(part => part.functionCall)
      .map(part => part.functionCall);
  }
}

module.exports = { Agent };