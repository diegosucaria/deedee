const { GoogleGenAI } = require('@google/genai');
const { createAssistantMessage } = require('@deedee/shared/src/types');
const { GSuiteTools } = require('@deedee/mcp-servers/src/gsuite/index');
const { LocalTools } = require('@deedee/mcp-servers/src/local/index');
const { AgentDB } = require('./db');
const { toolDefinitions } = require('./tools-definition');
const { Router } = require('./router'); // [NEW]

class Agent {
  constructor(config) {
    this.interface = config.interface;
    this.config = config; // Save config for later

    // 1. Initialize the unified Client
    this.client = new GoogleGenAI({ apiKey: config.googleApiKey });

    // Persistence
    this.db = new AgentDB();

    // Router
    this.router = new Router(config.googleApiKey); // [NEW]

    // Tools Setup
    this.gsuite = new GSuiteTools();
    this.local = new LocalTools('/app/source');

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

      // --- ROUTING ---
      const decision = await this.router.route(message.content);
      // Models: 'gemini-2.0-flash-exp' vs 'gemini-exp-1206' (or 1.5-pro)
      const selectedModel = decision.model === 'FLASH'
        ? (process.env.WORKER_FLASH || 'gemini-2.0-flash-exp')
        : (process.env.WORKER_PRO || 'gemini-exp-1206');

      console.log(`[Agent] Routing to: ${selectedModel}`);

      // --- HYDRATION ---
      const chatId = message.metadata?.chatId;
      const history = this.db.getHistoryForChat(chatId, 50); // Get last 50 turns

      // Initialize Stateless Chat Session
      const session = this.client.chats.create({
        model: selectedModel,
        config: {
          tools: toolDefinitions,
          systemInstruction: `
            You are Deedee, a helpful and capable AI assistant.
            You have access to a variety of tools to help the user.
            
            CRITICAL PROTOCOL:
            1. If you are asked to write code, modify files, or improve yourself, you MUST first call 'pullLatestChanges'.
            2. When you are done making changes, you MUST call 'commitAndPush'. This tool runs tests automatically.
            3. DO NOT use 'runShellCommand' for git operations (commit/push). Use the dedicated tools.
          `,
        },
        history: history
      });

      // 2. Send Message to Gemini
      let response = await session.sendMessage({ message: message.content });

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
        else if (call.name === 'pullLatestChanges') {
          // Trigger Supervisor Pull
          const pullRes = await fetch(`${process.env.SUPERVISOR_URL || 'http://supervisor:4000'}/cmd/pull`, {
            method: 'POST'
          });
          toolResult = await pullRes.json();
        }
        else if (call.name === 'commitAndPush') {
          // Trigger Supervisor Commit
          const commitRes = await fetch(`${process.env.SUPERVISOR_URL || 'http://supervisor:4000'}/cmd/commit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: call.args.message, files: ['.'] })
          });
          toolResult = await commitRes.json();
        }

        if (toolResult === undefined || toolResult === null) {
          toolResult = { info: 'No output from tool execution.' };
        }

        console.log('Tool Result:', toolResult);

        // Send Tool Response back to Gemini
        response = await session.sendMessage({
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