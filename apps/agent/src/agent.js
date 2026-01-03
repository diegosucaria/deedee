
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

    this.confirmationManager = new ConfirmationManager(this.db);
    // Shared state for stopping execution
    this.stopFlags = new Set();
    this.commandHandler = new CommandHandler(this.db, this.interface, this.confirmationManager, this.stopFlags);
    this.rateLimiter = new RateLimiter(this.db);

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
    try {
      const isMultiModal = !!message.parts;
      console.log(`Received: ${isMultiModal ? '[Multi-modal content]' : message.content}`);

      const chatId = message.metadata?.chatId;

      // Clear stop flag for this chat on new message (unless it's the stop command itself, handled by command handler)
      if (message.content !== '/stop') {
        this.stopFlags.delete(chatId);
      }

      // 1. Slash Commands (only for text messages)
      const commandResult = !isMultiModal ? await this.commandHandler.handle(message) : false;

      if (typeof commandResult === 'object' && commandResult.type === 'EXECUTE_PENDING') {
        // Execute the pending action immediately
        const action = commandResult.action;
        console.log(`[Agent] User confirmed action: ${action.name}`);
        const result = await this._executeTool(action.name, action.args, message, sendCallback);

        // Notify user of result
        const reply = createAssistantMessage(`Action **${action.name}** executed.\nResult: \`\`\`json\n${JSON.stringify(result, null, 2).substring(0, 500)}\n\`\`\``);
        reply.metadata = { chatId };
        reply.source = message.source;
        await sendCallback(reply);
        return;
      } else if (commandResult === true) {
        // Handled by command handler (e.g. /clear, /cancel)
        return;
      }

      // 2. Rate Limiting
      if (!(await this.rateLimiter.check(message, this.interface))) {
        return;
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
      const selectedModel = decision.model === 'FLASH'
        ? (process.env.WORKER_FLASH || 'gemini-2.0-flash-exp')
        : (process.env.WORKER_PRO || 'gemini-3-pro-preview');

      console.log(`[Agent] Routing to: ${selectedModel}`);

      // --- HYDRATION ---
      const history = this.db.getHistoryForChat(chatId, 50);

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

      // Initialize Stateless Chat Session
      const session = this.client.chats.create({
        model: selectedModel,
        config: {
          tools: geminiTools,
          systemInstruction: `
            You are Deedee, a helpful and capable AI assistant.
            You have access to a variety of tools to help the user.
            
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
            1. If you are asked to write code, modify files, or improve yourself, you MUST first call 'pullLatestChanges'.
            2. When you are done making changes, you MUST call 'commitAndPush'. This tool runs tests automatically.
            3. DO NOT use 'runShellCommand' for git operations (commit/push). Use the dedicated tools.
            4. DO NOT change/add/improve anything else in the code that was not asked for. Keep comments as is.
            5. All strings and comments you add must be in English.
            6. Since you can self-improve, when writing/adding/changing a tool/feature you must write the tests for it, to validate that it works before calling 'commitAndPush'.
            7. For multi-step tasks, execute tools in succession (chaining). DO NOT output intermediate text updates (like "I have pulled changes") unless you are blocked. Proceed directly to the next tool call.
            8. **Audio Responses**: When using 'replyWithAudio', keep your textual content EXTREMELY concise (1-2 sentences max). Speak in a fast-paced, energetic, and natural manner. Avoid filler words. Do not describe the audio, just speak it.
            9. **Language Preference**: When speaking Spanish via 'replyWithAudio', always set 'languageCode' to 'es-419' for a neutral Latin American accent, unless requested otherwise.
          `,
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
        if (this.stopFlags.has(chatId)) {
          console.log(`[Agent] Stop flag detected for chat ${chatId}. Breaking loop.`);
          await sendCallback(createAssistantMessage('🛑 Execution stopped by user.'));
          this.stopFlags.delete(chatId);
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

        const call = functionCalls[0];
        let executionName = call.name;

        // Sanitize Tool Name
        if (executionName && executionName.startsWith('default_api:')) {
          console.log(`[Agent] Sanitizing tool name for execution: ${executionName} -> ${executionName.replace('default_api:', '')}`);
          executionName = executionName.replace('default_api:', '');
        }

        let toolResult;
        let thinkTimer = null;

        // Delayed "Thinking..." Message (2.5s)
        thinkTimer = setTimeout(async () => {
          const thinkText = this._getThinkingMessage([call]);
          const thinkingMsg = createAssistantMessage(`Thinking... (${thinkText})`);
          thinkingMsg.metadata = { chatId: message.metadata?.chatId };
          thinkingMsg.source = message.source;
          await sendCallback(thinkingMsg).catch(err => console.error('[Agent] Failed to send thinking msg:', err));
        }, 2500);

        try {
          // SENSITIVE GUARD CHECK
          const guard = this.confirmationManager.check(executionName, call.args);
          if (guard.requiresConfirmation) {
            console.log(`[Agent] Action ${executionName} requires confirmation.`);
            this.confirmationManager.store(message.metadata?.chatId, executionName, call.args);

            toolResult = { info: `Action PAUSED. ${guard.message} User must confirm.` };

            // Notify user specifically
            const confirmMsg = createAssistantMessage(`🛑 **Safety Check**: I want to execute \`${executionName}\`.\n\nArgs: \`${JSON.stringify(call.args)}\`\n\n${guard.message}\n\nReply **/confirm** to proceed or **/cancel** to stop.`);
            confirmMsg.metadata = { chatId: message.metadata?.chatId };
            confirmMsg.source = message.source;
            await sendCallback(confirmMsg).catch(console.error);

            // We do NOT break here loop-wise because we want to return the info to the model so it knows it's paused.
            // However, the model usually stops after tool execution.
          } else {
            // Execute normally
            toolResult = await this._executeTool(executionName, call.args, message, sendCallback);
          }

        } catch (toolErr) {
          console.warn(`[Agent] Tool execution failed: ${toolErr.message}`);
          toolResult = { error: `Tool execution failed: ${toolErr.message}` };
        } finally {
          if (thinkTimer) clearTimeout(thinkTimer);
        }

        if (toolResult === undefined || toolResult === null) {
          toolResult = { info: 'No output from tool execution.' };
        }

        const logResult = JSON.stringify(toolResult);
        if (logResult.length > 200) {
          console.log('Tool Result (Truncated):', logResult.substring(0, 200) + '...');
        } else {
          console.log('Tool Result:', toolResult);
        }

        // SAVE TOOL RESPONSE (FunctionResponse)
        const functionResponsePart = {
          functionResponse: {
            name: call.name,
            response: { result: toolResult }
          }
        };

        this.db.saveMessage({
          role: 'function',
          parts: [functionResponsePart],
          metadata: { chatId: message.metadata?.chatId },
          source: message.source
        });

        // Send Tool Response back to Gemini
        const toolTimerLabel = `[Agent] Model Tool Response (${selectedModel}) - ${Date.now()}`;
        console.time(toolTimerLabel);
        response = await session.sendMessage({
          message: [functionResponsePart]
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

          await sendCallback(reply);
        }
      } else {
        console.warn('[Agent] No text response found. Response dump:', JSON.stringify(response, null, 2));
        // Fallback notification to user
        const reply = createAssistantMessage("I received an empty response from my brain. Please try again.");
        reply.metadata = { chatId: message.metadata?.chatId };
        reply.source = message.source;
        await sendCallback(reply);
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
    }
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

  async _executeTool(executionName, args, messageContext = {}, sendCallback) {
    // --- INTERNAL TOOLS ---
    if (executionName === 'rememberFact') {
      this.db.setKey(args.key, args.value);
      return { success: true };
    }
    if (executionName === 'getFact') {
      const val = this.db.getKey(args.key);
      return val ? { value: val } : { info: 'Fact not found in database.' };
    }
    if (executionName === 'addGoal') {
      const metadata = { chatId: messageContext.metadata?.chatId };
      const info = this.db.addGoal(args.description, metadata);
      return { success: true, id: info.lastInsertRowid };
    }
    if (executionName === 'completeGoal') {
      this.db.completeGoal(args.id);
      return { success: true };
    }
    // GSuite
    if (executionName === 'listEvents') return await this.gsuite.listEvents(args);
    if (executionName === 'sendEmail') return await this.gsuite.sendEmail(args);
    // Local
    if (executionName === 'readFile') return await this.local.readFile(args.path);
    if (executionName === 'writeFile') return await this.local.writeFile(args.path, args.content);
    if (executionName === 'listDirectory') return await this.local.listDirectory(args.path);
    if (executionName === 'runShellCommand') return await this.local.runShellCommand(args.command);
    // Audio / TTS
    if (executionName === 'replyWithAudio') {
      try {
        const text = args.text;
        const languageCode = args.languageCode;
        console.log(`[Agent] Generating audio for: "${text.substring(0, 50)}..." with optional lang: ${languageCode}`);

        const ttsModel = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';

        const speechConfig = {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: 'Kore' // AO, Fenrir, Kore, Puck
            }
          }
        };

        if (languageCode) {
          speechConfig.languageCode = languageCode;
        }

        const response = await this.client.models.generateContent({
          model: ttsModel,
          systemInstruction: 'Read the following text exactly as provided. Output ONLY audio.',
          contents: [{ parts: [{ text: text }] }],
          config: {
            responseModalities: ['AUDIO'],
            audioEncoding: 'LINEAR16',
            speechConfig: speechConfig
          }
        });


        if (!response.candidates || !response.candidates[0]) {
          throw new Error('No candidates returned from Gemini TTS');
        }

        const candidate = response.candidates[0];
        // The audio binary is usually in parts[0].inlineData.data
        let audioBase64 = null;
        if (candidate.content && candidate.content.parts) {
          for (const part of candidate.content.parts) {
            if (part.inlineData && part.inlineData.data) {
              audioBase64 = part.inlineData.data;
              break;
            }
          }
        }

        if (!audioBase64) {
          throw new Error('No audio data found in Gemini response');
        }

        // Convert PCM to WAV
        const pcmBuffer = Buffer.from(audioBase64, 'base64');
        const wavHeader = createWavHeader(pcmBuffer.length);
        const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);
        const wavBase64 = wavBuffer.toString('base64');

        const audioMsg = createAssistantMessage('[Audio Response]');
        audioMsg.metadata = { chatId: messageContext.metadata?.chatId };
        audioMsg.source = messageContext.source;
        audioMsg.content = wavBase64;
        audioMsg.type = 'audio';

        const finalSendCallback = sendCallback || (async (msg) => await this.interface.send(msg));
        await finalSendCallback(audioMsg);

        // Return success with metadata, not just true, so the model knows it worked
        return { success: true, info: 'Audio sent to user.' };

      } catch (e) {
        console.error('TTS Error (Gemini):', e);
        return { error: `TTS failed: ${e.message}` };
      }
    }

    // Supervisor
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

    // --- EXTERNAL MCP TOOLS ---
    try {
      return await this.mcp.callTool(executionName, args);
    } catch (err) {
      console.warn(`[Agent] Tool ${executionName} not found in Internal or MCP tools:`, err);
      return { error: `Tool ${executionName} failed or does not exist: ${err.message}` };
    }
  }
}

module.exports = { Agent };
