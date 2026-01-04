
const { createAssistantMessage } = require('@deedee/shared/src/types');
const { GSuiteTools } = require('@deedee/mcp-servers/src/gsuite/index');
const { LocalTools } = require('@deedee/mcp-servers/src/local/index');
const { AgentDB } = require('./db');
const { toolDefinitions } = require('./tools-definition');
const { Router } = require('./router');
const { MCPManager } = require('./mcp-manager');
const { CommandHandler } = require('./command-handler');
const { RateLimiter } = require('./rate-limiter');
const { ConfirmationManager } = require('./confirmation-manager');
const { ToolExecutor } = require('./tool-executor');
const path = require('path');
const { JournalManager } = require('./journal');
const { Scheduler } = require('./scheduler');
const axios = require('axios');

function createWavHeader(dataLength, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const buffer = Buffer.alloc(44);

  // RIFF identifier
  buffer.write('RIFF', 0);
  // file length
  buffer.writeUInt32LE(36 + dataLength, 4);
  // RIFF type
  buffer.write('WAVE', 8);
  // format chunk identifier
  buffer.write('fmt ', 12);
  // format chunk length
  buffer.writeUInt32LE(16, 16);
  // sample format (raw)
  buffer.writeUInt16LE(1, 20);
  // channel count
  buffer.writeUInt16LE(numChannels, 22);
  // sample rate
  buffer.writeUInt32LE(sampleRate, 24);
  // byte rate (sampleRate * blockAlign)
  buffer.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  // block align (channel count * bytes per sample)
  buffer.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  // bits per sample
  buffer.writeUInt16LE(bitsPerSample, 34);
  // data chunk identifier
  buffer.write('data', 36);
  // data chunk length
  buffer.writeUInt32LE(dataLength, 40);

  return buffer;
}

class Agent {
  constructor(config) {
    this.interface = config.interface;
    this.config = config; // Save config for later
    this.client = null;   // Will be init in start()

    // Persistence
    this.db = new AgentDB();

    // Router
    this.router = new Router(config.googleApiKey);

    // MCP Manager
    this.mcp = new MCPManager();

    // Tools Setup
    this.gsuite = new GSuiteTools();
    this.local = new LocalTools('/app/source');
    this.journal = new JournalManager();

    this.confirmationManager = new ConfirmationManager(this.db);
    // Shared state for stopping execution
    this.stopFlags = new Set();
    this.confirmationManager = new ConfirmationManager(this.db);
    // Shared state for stopping execution
    this.stopFlags = new Set();
    this.commandHandler = new CommandHandler(this.db, this.interface, this.confirmationManager, this.stopFlags);
    this.rateLimiter = new RateLimiter(this.db);

    this.scheduler = new Scheduler(this);

    this.toolExecutor = new ToolExecutor({
      local: this.local,
      journal: this.journal,
      scheduler: this.scheduler,
      gsuite: this.gsuite,
      mcp: this.mcp,
      client: null, // Will be populated in processMessage
      interface: this.interface
    });

    this.processMessage = this.processMessage.bind(this);
    this.onMessage = this.onMessage.bind(this);
  }

  async _loadClientLibrary() {
    return import('@google/genai');
  }

  async start() {
    console.log('Agent starting...');

    // 1. Initialize the unified Client (Dynamic Import for ESM)
    const { GoogleGenAI } = await this._loadClientLibrary();
    this.client = new GoogleGenAI({ apiKey: this.config.googleApiKey });

    // Initialize MCP
    await this.mcp.init();

    // Load Scheduled Jobs
    await this.scheduler.loadJobs();

    // Check Goals
    const pendingGoals = this.db.getPendingGoals();
    if (pendingGoals.length > 0) {
      console.log(`[Memory] I have ${pendingGoals.length} pending goals.`);

      for (const goal of pendingGoals) {
        console.log(` - Resuming: ${goal.description}`);
        if (goal.metadata && goal.metadata.chatId) {
          const msg = createAssistantMessage(`I am back online. Resuming task: "${goal.description}"`);
          msg.metadata = { chatId: goal.metadata.chatId };
          this.interface.send(msg).catch(err => console.error('[Agent] Failed to send resume msg:', err));
        }
      }
    }

    this.interface.on('message', this.onMessage);
    console.log('Agent listening for messages.');
  }

  async onMessage(message) {
    // Default handler: Send to Interface
    await this.processMessage(message, async (reply) => {
      await this.interface.send(reply);
    });
  }

  /**
   * Core processing logic.
   * @param {object} message - Incoming message
   * @param {function} sendCallback - Async function(reply) to handle responses
   */
  async processMessage(message, sendCallback) {
    const executionSummary = {
      toolOutputs: [], // List of { name, result }
      replies: []      // List of text/audio replies
    };

    try {
      const isMultiModal = !!message.parts;
      console.log(`Received: ${isMultiModal ? '[Multi-modal content]' : message.content}`);

      // Ensure client is ready (JIT)
      if (!this.client) {
        const { GoogleGenAI } = await this._loadClientLibrary();
        this.client = new GoogleGenAI({ apiKey: this.config.googleApiKey });
      }

      // Propagate dependencies to ToolExecutor
      this.toolExecutor.services.client = this.client;
      this.toolExecutor.services.interface = this.interface;

      const chatId = message.metadata?.chatId;

      // 0. Internal Health Check Interception
      if (message.metadata?.internal_health_check) {
        console.log('[Agent] Handling Internal Health Check. Skipping core logic.');
        const pong = createAssistantMessage('PONG');
        pong.source = 'system';
        // Skip DB Save
        await sendCallback(pong);
        executionSummary.replies.push(pong);
        return executionSummary;
      }

      // Clear stop flag for this chat on new message (unless it's the stop command itself, handled by command handler)
      if (message.content !== '/stop') {
        this.stopFlags.delete(chatId);
        this.stopFlags.delete('GLOBAL_STOP');
      }

      // 1. Slash Commands (only for text messages)
      const commandResult = !isMultiModal ? await this.commandHandler.handle(message) : false;

      if (typeof commandResult === 'object' && commandResult.type === 'EXECUTE_PENDING') {
        // Execute the pending action immediately
        const action = commandResult.action;
        console.log(`[Agent] User confirmed action: ${action.name}`);
        const result = await this._executeTool(action.name, action.args, message, sendCallback);

        executionSummary.toolOutputs.push({ name: action.name, result });

        // Notify user of result
        const reply = createAssistantMessage(`Action **${action.name}** executed.\nResult: \`\`\`json\n${JSON.stringify(result, null, 2).substring(0, 500)}\n\`\`\``);
        reply.metadata = { chatId };
        reply.source = message.source;
        await sendCallback(reply);
        executionSummary.replies.push(reply);
        return executionSummary;
      } else if (commandResult === true) {
        // Handled by command handler (e.g. /clear, /cancel)
        return executionSummary;
      }

      // 2. Rate Limiting
      if (!(await this.rateLimiter.check(message, this.interface))) {
        return executionSummary;
      }

      // 3. Save User Message
      this.db.saveMessage(message);

      // --- ROUTING ---
      console.time('[Agent] Router Duration');

      // Get brief history for context (last 3 messages)
      const routingHistory = this.db.getHistoryForChat(chatId, 3);

      // Pass the primary content or parts to router
      const decision = await this.router.route(message.parts || message.content, routingHistory);
      console.timeEnd('[Agent] Router Duration');
      console.log(`[Agent] Routing to: ${decision.model}`);

      // --- BYPASS: DIRECT IMAGE GENERATION ---
      if (decision.model === 'IMAGE') {
        console.log('[Agent] Executing Direct Image Generation Bypass');

        let prompt = message.content;
        // Handle multimodal prompt extraction if needed, but usually image gen prompt is text
        if (message.parts) {
          prompt = message.parts.map(p => p.text).join(' ');
        }

        const toolResult = await this._executeTool('generateImage', { prompt: prompt }, message, sendCallback);
        executionSummary.toolOutputs.push({ name: 'generateImage', result: toolResult });

        // Optionally send a text confirmation
        const reply = createAssistantMessage('Image generated.');
        reply.metadata = { chatId: message.metadata?.chatId };
        reply.source = message.source;
        await sendCallback(reply);
        executionSummary.replies.push(reply);

        // Save interaction
        this.db.saveMessage({
          role: 'assistant',
          content: 'Image generated (Direct Bypass)',
          metadata: { chatId: message.metadata?.chatId },
          source: message.source
        });

        return executionSummary;
      }

      const selectedModel = decision.model === 'FLASH'
        ? (process.env.WORKER_FLASH || 'gemini-2.0-flash-exp')
        : (process.env.WORKER_PRO || 'gemini-3-pro-preview');

      console.log(`[Agent] Routing to Model: ${selectedModel}`);

      // --- EXPERIMENTAL: Adaptive Context Window ---
      // Flash models (simple tasks) need less context. Pro models (reasoning) need more.
      const historyLimit = (decision.model === 'FLASH' || decision.model === 'IMAGE') ? 10 : 50;
      console.log(`[Agent] Fetching history with limit: ${historyLimit}`);

      // --- HYDRATION ---
      const history = this.db.getHistoryForChat(chatId, historyLimit);

      // --- TOOLS MERGE ---
      const mcpTools = await this.mcp.getTools();

      // Transform MCP tools to Gemini Format if not already compliant
      const externalTools = mcpTools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }));

      const allTools = [
        ...toolDefinitions[0].functionDeclarations, // Internal tools
        ...externalTools
      ];

      // construct the tools object for Gemini
      const geminiTools = [{ functionDeclarations: allTools }];

      // Build System Instruction
      let systemInstruction = `
            You are Deedee, a helpful and capable AI assistant.
            You have access to a variety of tools to help the user.
            
            CONSTITUTION:
            1. **Privacy First**: Never output or log API keys, passwords, or private user data (like full address) unless explicitly asked by the user in a safe context.
            2. **Data Integrity**: Never delete files or data without explicit confirmation, unless it is a temporary file you created.
            3. **Truthfulness**: If you do not know the answer, say so. Do not hallucinate capabilities or facts.
            4. **Safety**: Do not execute commands that could harm the system (e.g. "rm -rf / ", "mkfs") even if asked.
            
            CURRENT_TIME: ${new Date().toString()}
            
            REPO CONTEXT:
            - This is a Monorepo.
            - Apps: apps/agent, apps/supervisor, apps/interfaces
            - Packages: packages/mcp-servers, packages/shared
            - If a file is not found, verify the path using 'listDirectory'.

            TOOL USAGE GUIDELINES:
            1. **Prioritize Context**: If the user asks generic questions like "what happened?" or "status?", prioritize checking your Conversation History first. Do NOT call external tools (like Home Assistant, Calendar) unless the user explicitly mentions "house", "schedule", or similar words that indicate they are asking about something specific.
            2. **Lazy Fetching**: Do not fetch data speculatively. Only call a tool if you are 90% sure it contains the answer to the user's specific question.
            3. **Explanation**: If you are unsure what the user means by "what happened", ask for clarification instead of guessing with a tool call.

            CRITICAL PROTOCOL:
            1. If you are going to write code, modify files, or improve yourself, you MUST first call 'pullLatestChanges'.
            2. Do not start writing code automatically if the user did not ask for it. Even if the user asked for a new feature or change, ask for confirmation first, giving a brief summary of what you are going to do.
            2. When you are done making changes, you MUST call 'commitAndPush'. This tool runs tests automatically.
            3. DO NOT use 'runShellCommand' for git operations (commit/push). Use the dedicated tools.
            4. DO NOT change/add/improve anything else in the code that was not asked for. Keep comments as is.
            5. All strings and comments you add must be in English.
            6. Since you can self-improve, when writing/adding/changing a tool/feature you must write the tests for it, to validate that it works before calling 'commitAndPush'. You must also write documentation if required.
            7. This is a public repository, so when writing code or documentation, make sure you do not leak any sensitive or private information. The code will be used by others so make sure it is written with expandability and reusability in mind.
            8. For multi-step tasks, execute tools in succession (chaining). DO NOT output intermediate text updates (like "I have pulled changes") unless you are blocked. Proceed directly to the next tool call.
            9. **Audio Responses**: When using 'replyWithAudio', keep your textual content EXTREMELY concise (1-2 sentences max). Speak in a fast-paced, energetic, and natural manner. Avoid filler words. Do not describe the audio, just speak it.
            10. **Language Preference**: When speaking Spanish via 'replyWithAudio', always set 'languageCode' to 'es-419' for a neutral Latin American accent, unless requested otherwise.

            SMART HOME RULES (Home Assistant):
            1. **Memory First**: Before searching for a device (e.g. "turn on hallway light"), ALWAYS call 'lookupDevice' with the alias ("hallway light") first. Only if it returns null should you call 'ha_search_entities'.
            2. **Learn**: After successfully searching and finding a device for the first time, ALWAYS call 'learnDevice' to save it for next time.
            3. **100% Brightness**: When the user says "Turn On" a light, NEVER use 'ha_toggle' or generic turn_on (unless percentage is not supported by the entity). You MUST set specific brightness to 100% (or 255/100 depending on service). Use 'ha_call_service' with domain 'light', service 'turn_on', and data: { "entity_id": "...", "brightness_pct": 100 }.
            4. **Scheduling vs Automations**: Do NOT use Home Assistant to create automations for simple reminders or scheduling tasks (e.g. "Remind me to...", "Do X every day"). Use the 'scheduleJob' tool for these. Only use Home Assistant if the user explicitly asks to automate a smart device state (e.g. "Turn on lights at sunset").
      `;

      // Specific instruction for iPhone/Voice sources where dictation is unreliable
      if (['iphone', 'ios_shortcut'].includes(message.source)) {
        systemInstruction += `\n
            **DICTATION SAFEGUARD**: You are receiving input from iOS Voice Dictation. It is prone to errors.
            - If the user's request is AMBIGUOUS, resembles gibberish, or matches a tool only weakly (e.g. "turn on the light" but no room specified, or "play movie" but name is garbled), DO NOT EXECUTE THE TOOL.
            - Instead, ASK FOR CLARIFICATION: "Did you say [interpreted text]?" or "Which light?".
            - ONLY execute tools if the intent is crystal clear.
        `;
      }

      // Initialize Stateless Chat Session
      const session = this.client.chats.create({
        model: selectedModel,
        config: {
          tools: geminiTools,
          systemInstruction: systemInstruction,
        },
        history: history
      });

      // 2. Send Message to Gemini
      const timerLabel = `[Agent] Model Response (${selectedModel}) - ${Date.now()}`;
      console.time(timerLabel);
      let response = await session.sendMessage({ message: message.parts || message.content });
      console.timeEnd(timerLabel);

      // 3. Handle Function Calls Loop
      let functionCalls = this._getFunctionCalls(response);


      const MAX_LOOPS = parseInt(process.env.MAX_TOOL_LOOPS || '10');
      let loopCount = 0;

      while (functionCalls && functionCalls.length > 0) {
        // CHECK STOP FLAG
        if (this.stopFlags.has(chatId) || this.stopFlags.has('GLOBAL_STOP')) {
          console.log(`[Agent] Stop flag detected for chat ${chatId}. Breaking loop.`);
          await sendCallback(createAssistantMessage('🛑 Execution stopped by user.'));
          this.stopFlags.delete(chatId);
          // Do NOT delete GLOBAL_STOP here, so it hits other concurrent loops.
          // It will be cleared on next user input.
          break;
        }

        loopCount++;
        if (loopCount > MAX_LOOPS) {
          console.warn(`[Agent] Max tool loop limit reached (${MAX_LOOPS}). Breaking.`);
          await sendCallback(createAssistantMessage('I am stuck in a loop. Stopping now.'));
          break;
        }

        // Periodic Feedback (every 3rd loop, starting at 3)
        if (loopCount > 1 && loopCount % 3 === 0) {
          const thinkText = this._getThinkingMessage(functionCalls);
          const updateMsg = createAssistantMessage(`Still working... (${thinkText})`);
          updateMsg.metadata = { chatId: message.metadata?.chatId };
          updateMsg.source = message.source;
          await sendCallback(updateMsg).catch(err => console.error('[Agent] Failed to send update msg:', err));
        }

        // SAVE MODEL FUNCTION CALL (Intermediate)
        if (response.candidates && response.candidates[0]) {
          const fcParts = response.candidates[0].content.parts;
          this.db.saveMessage({
            role: 'model',
            parts: fcParts,
            metadata: { chatId: message.metadata?.chatId },
            source: message.source
          });
        }

        // PARALLEL EXECUTION STRATEGY
        console.log(`[Agent] Processing ${functionCalls.length} tool calls in parallel.`);

        // 1. Start Global Thinking Timer (for the batch)
        let thinkTimer = setTimeout(async () => {
          const thinkText = this._getThinkingMessage(functionCalls);
          const thinkingMsg = createAssistantMessage(`Thinking... (${thinkText})`);
          thinkingMsg.metadata = { chatId: message.metadata?.chatId };
          thinkingMsg.source = message.source;
          await sendCallback(thinkingMsg).catch(err => console.error('[Agent] Failed to send thinking msg:', err));
        }, 2500);

        // 2. Execute All Tools
        const toolPromises = functionCalls.map(async (call) => {
          let executionName = call.name;
          // Sanitize Tool Name
          if (executionName && executionName.startsWith('default_api:')) {
            executionName = executionName.replace('default_api:', '');
          }

          let toolResult;
          try {
            // SENSITIVE GUARD CHECK
            const guard = this.confirmationManager.check(executionName, call.args);
            if (guard.requiresConfirmation) {
              console.log(`[Agent] Action ${executionName} requires confirmation.`);
              this.confirmationManager.store(message.metadata?.chatId, executionName, call.args);

              // Notify user specifically
              const confirmMsg = createAssistantMessage(`🛑 **Safety Check**: I want to execute \`${executionName}\`.\n\nArgs: \`${JSON.stringify(call.args)}\`\n\n${guard.message}\n\nReply **/confirm** to proceed or **/cancel** to stop.`);
              confirmMsg.metadata = { chatId: message.metadata?.chatId };
              confirmMsg.source = message.source;
              await sendCallback(confirmMsg).catch(console.error);

              toolResult = { info: `Action PAUSED. ${guard.message} User must confirm.` };
            } else {
              // Execute normally
              toolResult = await this._executeTool(executionName, call.args, message, sendCallback);
            }
          } catch (toolErr) {
            console.warn(`[Agent] Tool execution failed (${executionName}): ${toolErr.message}`);
            toolResult = { error: `Tool execution failed: ${toolErr.message}` };
          }

          if (toolResult === undefined || toolResult === null) {
            toolResult = { info: 'No output from tool execution.' };
          }

          return { call, executionName, result: toolResult };
        });

        // Wait for all tools
        const results = await Promise.all(toolPromises);
        clearTimeout(thinkTimer);

        // 3. Process Results & Build Response
        const functionResponseParts = [];
        const dbFunctionResponseParts = [];

        for (const { call, executionName, result } of results) {
          // Capture to Summary
          executionSummary.toolOutputs.push({ name: executionName, result });

          // Log
          const logResult = JSON.stringify(result);
          if (logResult.length > 200) {
            console.log(`Tool Result (${executionName}) (Truncated):`, logResult.substring(0, 200) + '...');
          } else {
            console.log(`Tool Result (${executionName}):`, result);
          }

          // Sanitize for DB AND Model to prevent Context Pollution
          let dbToolResult = result;
          if (executionName === 'generateImage') {
            // Gemini does NOT need the base64. It just needs success.
            dbToolResult = { info: 'Image generated and sent to user.' };
          } else if (result && result.image_base64 && result.image_base64.length > 500) {
            dbToolResult = { ...result, image_base64: '<BASE64_IMAGE_TRUNCATED>' };
          }

          // Build API Payload (Send CLEAN result to Model)
          functionResponseParts.push({
            functionResponse: {
              name: call.name,
              response: { result: dbToolResult }
            }
          });

          // Build DB Payload
          dbFunctionResponseParts.push({
            functionResponse: {
              name: call.name,
              response: { result: dbToolResult }
            }
          });
        }

        // 4. Save Function Results to DB
        this.db.saveMessage({
          role: 'function',
          parts: dbFunctionResponseParts,
          metadata: { chatId: message.metadata?.chatId },
          source: message.source
        });

        // 5. Send All Results back to Gemini
        const toolTimerLabel = `[Agent] Model Tool Response (${selectedModel}) - ${Date.now()}`;
        console.time(toolTimerLabel);
        response = await session.sendMessage({
          message: functionResponseParts
        });
        console.timeEnd(toolTimerLabel);

        // Re-check for recursive function calls 
        functionCalls = this._getFunctionCalls(response);
      }

      // 4. Final Text Response
      // SDK might expose text via method or property depending on version/response type
      let text = '';
      if (typeof response.text === 'function') {
        try {
          text = response.text();
        } catch (e) {
          // Sometimes text() throws if candidate safety blocked
          console.warn('[Agent] response.text() threw:', e.message);
        }
      } else if (response.text) {
        text = response.text;
      } else if (response.candidates && response.candidates[0] && response.candidates[0].content) {
        // Validation fallback
        text = response.candidates[0].content.parts
          .filter(p => p.text)
          .map(p => p.text)
          .join(' ');
      }

      if (text) {
        if (message.source === 'http') {
          console.log('[Agent] Final Response (to console):', text);
        } else {
          const reply = createAssistantMessage(text);
          reply.metadata = { chatId: message.metadata?.chatId };
          reply.source = message.source; // Ensure reply source matches incoming message source

          // 2. Save Assistant Reply
          this.db.saveMessage(reply);

          // Check if we already sent audio
          const audioTool = executionSummary.toolOutputs.find(t => t.name === 'replyWithAudio');
          const audioSent = audioTool && audioTool.result && audioTool.result.success;

          if (audioSent) {
            console.log('[Agent] Suppressing final text response because audio was sent.');
            // We saved it to DB above, but we do NOT send it to interface to avoid double notification.
          } else {
            await sendCallback(reply);
          }

          executionSummary.replies.push(reply);
        }
      } else {
        // If we executed tools but got no final text, assume success and generate a generic confirmation.
        if (executionSummary.toolOutputs.length > 0) {
          console.log('[Agent] No text response after tool execution. Assuming implicit success.');
          const lastTool = executionSummary.toolOutputs[executionSummary.toolOutputs.length - 1];
          const reply = createAssistantMessage(`✅ Action ${lastTool.name} completed.`);
          reply.metadata = { chatId: message.metadata?.chatId };
          reply.source = message.source;

          // Save implicit reply
          this.db.saveMessage(reply);

          await sendCallback(reply);
          executionSummary.replies.push(reply);
        } else {
          console.warn('[Agent] No text response found. Response dump:', JSON.stringify(response, null, 2));
          // Fallback notification to user
          const reply = createAssistantMessage("I received an empty response from my brain. Please try again.");
          reply.metadata = { chatId: message.metadata?.chatId };
          reply.source = message.source;
          await sendCallback(reply);
          executionSummary.replies.push(reply);
        }
      }

    } catch (error) {
      console.error('Error processing message:', error);

      const chatId = message.metadata?.chatId;
      if (chatId && message.timestamp) {
        console.warn(`[Agent] Performing Auto-Rollback for chat ${chatId} since ${message.timestamp}`);
        this.db.deleteMessagesSince(chatId, message.timestamp);
      }

      const errReply = createAssistantMessage(`Error: ${error.message} (Automatic Rollback performed)`);
      errReply.metadata = { chatId: message.metadata?.chatId };
      errReply.source = message.source;
      await sendCallback(errReply);
      executionSummary.replies.push(errReply);
    }

    return executionSummary;
  }

  _getFunctionCalls(response) {
    const candidates = response.candidates;
    if (!candidates || !candidates.length) return [];

    const content = candidates[0].content;
    if (!content || !content.parts) return [];

    return content.parts
      .filter(part => part.functionCall)
      .map(part => part.functionCall);
  }

  _getThinkingMessage(calls) {
    if (!calls || calls.length === 0) return 'Thinking...';

    const name = calls[0].name;

    switch (name) {
      case 'readFile': return 'Reading file...';
      case 'writeFile': return 'Writing to file...';
      case 'listDirectory': return 'Checking directory contents...';
      case 'runShellCommand': return 'Running system command...';
      case 'pullLatestChanges': return 'Pulling latest code...';
      case 'commitAndPush': return 'Committing changes...';
      case 'rollbackLastChange': return 'Rolling back changes...';
      case 'listEvents': return 'Checking calendar...';
      case 'sendEmail': return 'Sending email...';
      case 'logJournal': return 'Writing to journal...';
      case 'rememberFact':
      case 'getFact': return 'Accessing memory...';
      case 'addGoal':
      case 'completeGoal': return 'Updating goals...';
      case 'replyWithAudio': return 'Generating voice response...';
      default: return `Executing ${name}...`;
    }
  }

  async stop() {
    console.log('[Agent] Stopping...');

    // Stop MCP
    if (this.mcp) {
      await this.mcp.close();
    }

    // Close DB
    if (this.db && this.db.db) {
      this.db.db.close();
    }

    // Stop Interface (if applicable)
    if (this.interface && typeof this.interface.stop === 'function') {
      this.interface.stop();
    }

    console.log('[Agent] Stopped.');
  }

  async _executeTool(executionName, args, message, sendCallback) {
    // --- INTERNAL DB TOOLS ---
    if (executionName === 'rememberFact') {
      this.db.setKey(args.key, args.value);
      return { success: true };
    }
    if (executionName === 'getFact') {
      const val = this.db.getKey(args.key);
      return val ? { value: val } : { info: 'Fact not found in database.' };
    }
    if (executionName === 'addGoal') {
      const metadata = { chatId: message.metadata?.chatId };
      const info = this.db.addGoal(args.description, metadata);
      return { success: true, id: info.lastInsertRowid };
    }
    if (executionName === 'completeGoal') {
      this.db.completeGoal(args.id);
      return { success: true };
    }

    // --- SMART HOME MEMORY ---
    if (executionName === 'lookupDevice') {
      const entityId = this.db.getDeviceAlias(args.alias);
      if (entityId) return { entityId: entityId };
      return { info: `No alias found for '${args.alias}'. Scan/Search HA first.` };
    }
    if (executionName === 'learnDevice') {
      this.db.saveDeviceAlias(args.alias, args.entityId);
      return { success: true, info: `Saved alias '${args.alias}' -> '${args.entityId}'` };
    }

    // --- SUPERVISOR TOOLS ---
    if (executionName === 'rollbackLastChange') {
      const rollbackRes = await fetch(`${process.env.SUPERVISOR_URL || 'http://supervisor:4000'}/cmd/rollback`, {
        method: 'POST'
      });
      return await rollbackRes.json();
    }
    if (executionName === 'pullLatestChanges') {
      const pullRes = await fetch(`${process.env.SUPERVISOR_URL || 'http://supervisor:4000'}/cmd/pull`, {
        method: 'POST'
      });
      return await pullRes.json();
    }
    if (executionName === 'commitAndPush') {
      const commitRes = await fetch(`${process.env.SUPERVISOR_URL || 'http://supervisor:4000'}/cmd/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: args.message, files: ['.'] })
      });
      const toolResult = await commitRes.json();

      // Notification: Slack (Self-Improvement Alert)
      if (toolResult && toolResult.success && process.env.SLACK_WEBHOOK_URL) {
        try {
          await fetch(process.env.SLACK_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: `🚀 *New Feature Deployed via Self-Improvement*\n\n*Commit:* ${args.message}\n*Files:* All changed files`
            })
          });
          console.log('[Agent] Sent Slack notification for self-improvement.');
        } catch (slackErr) {
          console.error('[Agent] Failed to send Slack notification:', slackErr);
        }
      }
      return toolResult;
    }

    // --- DELEGATE TO EXECUTOR (File, Scheduler, GSuite, Image, Audio, MCP) ---
    try {
      return await this.toolExecutor.execute(executionName, args, {
        message,
        sendCallback,
        processMessage: this.processMessage.bind(this)
      });
    } catch (error) {
      console.error(`[Agent] Tool Execution Error (${executionName}):`, error);
      throw error;
    }
  }
}

module.exports = { Agent };
