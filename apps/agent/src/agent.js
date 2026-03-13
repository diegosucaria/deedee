
const { createAssistantMessage } = require('@deedee/shared/src/types');
const fs = require('fs-extra');
const crypto = require('crypto');
// const { GSuiteTools } = require('@deedee/mcp-servers/src/gsuite/index');
const { LocalTools } = require('@deedee/mcp-servers/src/local/index');

const { AgentDB } = require('./db');
const { SmartContextManager } = require('./smart-context');
const { toolDefinitions } = require('./tools-definition');
const { Router } = require('./router');
const { MCPManager } = require('./mcp-manager');
const { CommandHandler } = require('./command-handler');
const { RateLimiter } = require('./rate-limiter');
const { ConfirmationManager } = require('./confirmation-manager');
const { ImpersonationService } = require('./services/impersonation');
const { ToolExecutor } = require('./tool-executor');
const path = require('path');
const { JournalManager } = require('./journal');
const VaultManager = require('./vault-manager');
const { BackupManager } = require('./backup');
const { Scheduler } = require('./scheduler');
const axios = require('axios');
const { getSystemInstruction } = require('./prompts/system');
const { getFunctionCalls, getThinkingMessage } = require('./utils/helpers');
const { geminiToOpenAIHistory, openAIToGeminiChunk } = require('./utils/mapper');
const { PeopleService } = require('./services/people-service');
const { AnalysisService } = require('./services/analysis-service');
const { TitleService } = require('./services/title-service');
const { ConfigService } = require('./services/config-service');
const { RagService } = require('./services/rag-service');
const { DJService } = require('./services/dj-service');
const { SkillService } = require('./services/skill-service');
const { MemoryPruningService } = require('./services/memory-pruning');
const { DreamService } = require('./services/dream-service');
const { SubAgentService } = require('./services/subagent-service');
const { ToolScoper } = require('./services/tool-scoper');
const { sanitizeToolResult } = require('./utils/tool-result-sanitizer');
const { NotificationService } = require('./utils/notifications');



class Agent {
  constructor(config) {
    this.interface = config.interface;
    this.config = config; // Save config for later
    this.client = null;   // Will be init in start()

    // Persistence
    this.db = config.db || new AgentDB();
    // Fallback for tests where dbPath might be undefined due to mocking
    const dataDir = this.db.dbPath ? path.dirname(this.db.dbPath) : path.join(process.cwd(), 'data');
    this.smartContext = new SmartContextManager(this.db, this.client); // Client is null here, need to set later

    // Router
    this.router = new Router(config.googleApiKey);

    // MCP Manager
    this.mcp = new MCPManager(path.join(dataDir, 'mcp_config.json'));

    // Tools Setup
    this.local = new LocalTools('/app/source');
    this.journal = new JournalManager();
    this.vaults = new VaultManager(dataDir); // Initialize Vaults with dynamic path
    this.backupManager = new BackupManager(this);

    this.confirmationManager = new ConfirmationManager(this.db);
    // Shared state for stopping execution
    this.stopFlags = new Set();
    this.cancellationFlags = new Set(); // For stopping chat generation
    this.activeTopics = new Map(); // Store active vault topics per chatId
    // Initialize Command Handler
    this.commandHandler = new CommandHandler(this.db, this.interface, this.confirmationManager, this.stopFlags, this);
    this.rateLimiter = new RateLimiter(this.db);

    this.scheduler = new Scheduler(this);

    // Services
    this.peopleService = new PeopleService(this);
    this.analysisService = new AnalysisService(this);
    this.titleService = new TitleService(this);
    this.configService = new ConfigService();
    this.ragService = new RagService(this);
    this.journal.setRagService(this.ragService);
    this.djService = new DJService(this);
    this.impersonationService = new ImpersonationService(this);
    this.skillService = new SkillService(this);
    this.memoryPruning = new MemoryPruningService(this);
    this.dreamService = new DreamService(this);
    this.subAgentService = new SubAgentService(this);
    this.toolScoper = new ToolScoper(config.googleApiKey, this.db);
    this.notifications = new NotificationService(this.db, this.interface);

    // In-Memory Settings Cache
    this.settings = {};

    this.toolExecutor = new ToolExecutor({
      local: this.local,
      journal: this.journal,
      vaults: this.vaults, // Pass Vaults to Executor
      scheduler: this.scheduler,
      mcp: this.mcp,
      dj: this.djService,
      db: this.db,
      agent: this
      // Note: client and interface are passed per-call via context.callServices
      // to avoid race conditions when multiple processMessage calls run concurrently
    });

    this.processMessage = this.processMessage.bind(this);
    this.onMessage = this.onMessage.bind(this);
  }


  async _loadClientLibrary() {
    return import('@google/genai');
  }

  // FORCE STOP a specific chat generation
  async stopGeneration(chatId) {
    console.log(`[Agent] Stop requested for chat ${chatId}`);
    this.cancellationFlags.add(chatId);
  }

  async stop() {
    this.isStopped = true;
    console.log('[Agent] Stopping...');
    if (this.scheduler) {
      await this.scheduler.stop();
    }
    if (this.mcp) {
      try {
        await this.mcp.close();
      } catch (err) {
        console.error('[Agent] Error closing MCP:', err);
      }
    }
    if (this.db) {
      this.db.close();
    }
  }

  async start() {
    this.isStopped = false;
    console.log('Agent starting...');

    // Mark any sub-agents left as 'running' from a previous session as failed
    const staleCount = this.db.markStaleSubAgents();
    if (staleCount > 0) {
      console.log(`[SubAgent] Marked ${staleCount} stale sub-agent(s) as failed from previous session.`);
    }

    // 1. Initialize the unified Client (Dynamic Import for ESM)
    const { GoogleGenAI } = await this._loadClientLibrary();
    this.client = new GoogleGenAI({ apiKey: this.config.googleApiKey });

    // Initialize MCP
    await this.mcp.init();

    // Load Settings (API Keys, etc)
    const settings = this.db.getAllAgentSettings();
    this.settings = settings; // Update this.settings for consistency

    // Check for xAI config
    if (settings['provider:xai']?.apiKey) {
      // ... switch to xai ...
      const apiKey = settings['provider:xai'].apiKey;
      try {
        const OpenAI = require('openai');
        this.xaiClient = new OpenAI({
          apiKey: apiKey,
          baseURL: 'https://api.x.ai/v1'
        });
        console.log('[Agent] xAI Client Initialized (Grok)');
      } catch (e) {
        console.error('[Agent] Failed to init xAI client:', e);
      }
    }

    // Load Scheduled Jobs
    await this.scheduler.loadJobs();

    // Initialize Vaults
    await this.vaults.initialize();
    await this.djService.initialize();

    // Ensure System Maintenance Jobs
    this.scheduler.ensureSystemJobs();

    // Initialize Skills
    await this.skillService.init();

    // --- DEBUG: Dump System Prompt ---
    try {
      const skillsContext = this.skillService.getGlobalInstructions();
      // Mock data for snapshot to show full potential size
      const dumpPrompt = getSystemInstruction(
        new Date().toISOString(),
        "No active goals (snapshot)",
        "No facts (snapshot)",
        { codingMode: true, skillsContext }
      );

      const snapshot = {
        event: "SYSTEM_PROMPT_SNAPSHOT",
        timestamp: new Date().toISOString(),
        stats: {
          characterCount: dumpPrompt.length,
          estimatedTokens: Math.ceil(dumpPrompt.length / 4)
        },
        content: dumpPrompt
      };

      // Log as JSON string for automatic collapsing in log viewers
      console.log(JSON.stringify(snapshot));

    } catch (e) {
      console.warn('[Agent] Failed to dump system prompt:', e);
    }

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

    // --- MEMORY SYNC ---
    try {
      console.log('[Memory] Syncing DB Facts to Durable Memory...');
      const facts = this.db.getAllFacts();
      const memoryPath = await this.journal.syncFactsToMemory(facts);
      // Add minimal delay to ensure write flush
      await new Promise(r => setTimeout(r, 100));
      await this.ragService.ingestDocument(memoryPath, 'memory'); // Special vault 'memory' or null
      console.log('[Memory] Durable Memory synced and ingested.');
    } catch (e) {
      console.error('[Memory] Startup Sync Failed:', e.message);
    }

    this.interface.on('message', this.onMessage);
    console.log('Agent listening for messages.');
  }

  async onMessage(message) {
    // Intercept Presence Updates for Autopilot Debounce
    if (message.type === 'presence') {
      const { chatId, status } = message.metadata || {};
      if (chatId && status) {
        this.impersonationService.handlePresenceUpdate(chatId, status);
      }
      return;
    }

    if (this.isStopped) {
      console.warn('[Agent] Received message while stopped. Ignoring.');
      // Optionally reply with 503 or just ignore
      return;
    }

    // Default handler: Send to Interface
    await this.processMessage(message, async (reply) => {
      // HANDLE SIMULATION REDIRECT
      if (message.metadata?.simulationRedirect) {
        console.log(`[Agent] Redirecting simulation reply to ${message.metadata.simulationRedirect.chatId}`);
        reply.metadata = { ...reply.metadata, chatId: message.metadata.simulationRedirect.chatId };
        reply.source = message.metadata.simulationRedirect.source;

        // Add visual cue it's a simulation result
        if (reply.parts) {
          reply.parts.unshift({ text: "📝 **[SIMULATION RESULT]**\n" });
        } else if (reply.content) {
          reply.content = "📝 **[SIMULATION RESULT]**\n" + reply.content;
        }
      }
      await this.interface.send(reply);
    });
  }

  /**
   * Helper to send message efficiently with streaming and token broadcasting
   */
  async _generateStream(session, payload, chatId, source) {
    // Retry helper for transient network errors (up to 5 retries with backoff)
    const MAX_RETRIES = 5;
    const _isRetryable = (err) => {
      const msg = (err.message || '').toLowerCase();
      // Only retry on network errors or 503/429
      return msg.includes('fetch failed') || msg.includes('econnreset') || msg.includes('etimedout') ||
        msg.includes('socket hang up') || msg.includes('network') ||
        err.status === 503 || err.status === 429 || err.statusCode === 503 || err.statusCode === 429;
    };
    const _retryCall = async (fn) => {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        let timer;
        try {
          const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error('Model request timed out after 60 seconds (Possible SDK hang or 503)'));
            }, 60000);
          });
          return await Promise.race([fn(), timeoutPromise]);
        } catch (err) {
          if (attempt < MAX_RETRIES && _isRetryable(err)) {
            // Exponential backoff: 2s, 4s, 8s, 16s, 32s
            const delay = Math.pow(2, attempt + 1) * 1000;
            console.warn(`[Agent] Retryable error (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message}. Retrying in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
          } else {
            throw err;
          }
        } finally {
          clearTimeout(timer);
        }
      }
    };

    try {
      // SDK REQUIREMENT Check: Input Validation
      if (!payload) throw new Error('Payload cannot be empty.');

      // FIX: proactively normalize payload to prevent SDK "ContentUnion is required" error
      // The SDK is strict about what it accepts in { message: ... }
      let normalizedMessage = { role: 'user', parts: [] };
      let shouldUseRaw = false;

      if (typeof payload === 'string') {
        normalizedMessage.parts.push({ text: payload });
      } else if (payload.parts && Array.isArray(payload.parts)) {
        // Already formatted
        normalizedMessage = payload;
      } else if (Array.isArray(payload)) {
        // Function response array - The SDK expects { role: 'user', parts: [...] } or { role: 'function', parts: [...] }
        // For Gemini v1beta/v2, function responses are sent as 'function' role or 'user' role with functionResponse parts.
        // Default: bind array payload as parts of a 'user' message
        normalizedMessage.parts = payload;
      } else if (typeof payload === 'object') {
        // Try to salvage object input (e.g. from tool output or malformed request)
        if (payload.text) {
          normalizedMessage.parts.push({ text: payload.text });
        } else {
          // Fallback or ignore
          try {
            const jsonStr = JSON.stringify(payload);
            if (jsonStr === '{}') throw new Error('Empty object payload');
            // If completely unknown object, treat as text?
            // normalizedMessage.parts.push({ text: jsonStr });
          } catch (e) { /* ignore */ }
        }
      }

      // Safety Check
      if (!shouldUseRaw && (!normalizedMessage.parts || !Array.isArray(normalizedMessage.parts) || normalizedMessage.parts.length === 0)) {
        console.warn('[Agent] Payload normalization failed. Attempting raw pass.');
        normalizedMessage = payload;
      }

      // Web/Live: Enable Streaming
      if (source === 'web' || source === 'live') {
        console.log(`[Agent] Streaming request content type: ${typeof payload}`);

        // SDK Expects { message: ... } for sendMessageStream
        const result = await _retryCall(() => session.sendMessageStream({ message: normalizedMessage }));

        // Handle both iterable result (new SDK) and result.stream (legacy/mock)
        const stream = result.stream || result;

        let fullText = '';
        const aggregatedParts = [];
        let streamUsageMetadata = null;

        for await (const chunk of stream) {
          // CHECK CANCELLATION
          if (this.cancellationFlags.has(chatId)) {
            console.log(`[Agent] Generation cancelled for ${chatId}`);
            this.cancellationFlags.delete(chatId);
            fullText += "\n\n*[Stopped by User]*";
            // Broadcast stop
            if (this.interface.broadcast) {
              this.interface.broadcast('agent:token', { chatId, content: "\n\n*[Stopped by User]*", timestamp: Date.now() });
            }
            break; // Exit loop
          }

          let text = '';
          try {
            // chunk.text() throws if the chunk has no text (e.g. only function call)
            if (typeof chunk.text === 'function') {
              text = chunk.text();
            }
          } catch (e) { /* ignore */ }

          // Fallback extraction if text() failed or wasn't available
          if (!text && chunk.candidates?.[0]?.content?.parts) {
            const part = chunk.candidates[0].content.parts.find(p => p.text);
            if (part) text = part.text;
          }

          // Capture usage metadata (SDK includes it on the last chunk)
          if (chunk.usageMetadata) streamUsageMetadata = chunk.usageMetadata;

          // Aggregate parts for final response (Function Calls etc.)
          if (chunk.candidates?.[0]?.content?.parts) {
            chunk.candidates[0].content.parts.forEach(p => {
              // Deduplicate text parts if possible, or just push.
              // For function calls, we MUST preserve them.
              if (p.functionCall) aggregatedParts.push(p);
            });
          }

          if (text) {
            fullText += text;
            if (this.interface.broadcast) {
              this.interface.broadcast('agent:token', {
                chatId,
                content: text,
                timestamp: Date.now()
              });
            } else {
              // Fallback for tests/mocks
              this.interface.emit('agent:token', {
                chatId,
                content: text,
                timestamp: Date.now()
              });
            }
          }
        }

        // Construct synthetic response for processMessage
        // If we have function calls, aggregatedParts has them.
        // If we have text, we should ensure it's in the parts.
        if (fullText) {
          aggregatedParts.push({ text: fullText });
        }

        const response = {
          candidates: [{
            content: {
              role: 'model',
              parts: aggregatedParts
            }
          }],
          ...(streamUsageMetadata && { usageMetadata: streamUsageMetadata })
        };

        return response;
      } else {
        // Standard (WhatsApp/Telegram) - No stream
        // FIX: Use normalizedMessage here too!
        // SDK Expects { message: ... } for sendMessage in new SDK versions too, or strict types
        const result = await _retryCall(() => session.sendMessage({ message: normalizedMessage }));
        let response = result.response;
        if (!response && result.candidates) response = result;
        return response;
      }
    } catch (e) {
      console.error(`[Agent] sendMessage failed after retries: ${e.message}`);
      // Fallback to standard if stream fails?
      if (source === 'web' && !e.message.includes('sendMessage')) {
        try {
          const result = await session.sendMessage(payload);
          return result.response;
        } catch (ex) { throw ex; }
      }
      throw e;
    }
  }

  /**
   * Generates stream from Grok/OpenAI client and broadcasts tokens.
   */
  async _generateStreamGrok(client, model, userContent, history, chatId) {
    try {
      // 1. Map History
      const messages = geminiToOpenAIHistory(history);

      // 2. Add current user message
      messages.push({ role: 'user', content: userContent });

      // 3. Create Stream
      const stream = await client.chat.completions.create({
        model: model,
        messages: [
          { role: 'system', content: this.currentSystemPrompt || 'You are DeeDee, a helpful AI assistant.' }, // Fallback if not set
          ...messages
        ],
        stream: true,
        stream_options: { include_usage: true }
      });

      let fullText = '';
      let streamUsage = null;

      for await (const chunk of stream) {
        const content = chunk.choices?.[0]?.delta?.content || '';
        if (content) {
          fullText += content;
          // Broadcast
          if (this.interface.broadcast) {
            this.interface.broadcast('agent:token', {
              chatId,
              content: content,
              timestamp: Date.now()
            });
          } else {
            this.interface.emit('agent:token', {
              chatId,
              content: content,
              timestamp: Date.now()
            });
          }
        }
        // Final chunk includes usage data
        if (chunk.usage) streamUsage = chunk.usage;
      }

      // Log token usage for Grok/OpenAI calls
      if (streamUsage && this.db) {
        const promptTokens = streamUsage.prompt_tokens || 0;
        const completionTokens = streamUsage.completion_tokens || 0;
        const cost = calculateCost(model, promptTokens, completionTokens);
        this.db.logTokenUsage({
          model, promptTokens, candidateTokens: completionTokens,
          totalTokens: promptTokens + completionTokens, chatId, estimatedCost: cost, tag: 'grok'
        });
        console.log(`[Tokens-Grok] P: ${promptTokens} | C: ${completionTokens} | Cost: $${cost.toFixed(6)}`);
      }

      return fullText;

    } catch (e) {
      console.error('[Agent] Grok generation failed:', e);
      throw e;
    }
  }

  /**
   * Core processing logic.
   * @param {object} message - Incoming message
   * @param {function} sendCallback - Async function(reply) to handle responses
   * @param {function} onProgress - Optional async function(status) to report progress
   */
  async processMessage(message, originalSendCallback, onProgress = async () => { }) {
    let activeSendCallback = originalSendCallback;
    const reportProgress = async (status) => {
      try { await onProgress(status); } catch (e) { /* ignore */ }
    };

    const runId = crypto.randomUUID();
    const e2eStart = Date.now();
    const executionSummary = {
      toolOutputs: [], // List of { name, result }
      replies: []      // List of text/audio replies
    };

    try {
      const isMultiModal = !!message.parts;

      // Ensure client is ready (JIT)
      if (!this.client) {
        const { GoogleGenAI } = await this._loadClientLibrary();
        this.client = new GoogleGenAI({ apiKey: this.config.googleApiKey });
      }

      // Ensure SmartContext has the client for summarization
      this.smartContext.client = this.client;

      const chatId = message.metadata?.chatId;
      const isSubAgent = !!message.metadata?.isSubAgent;
      const taskId = message.metadata?.taskId;
      // Dynamic Log Prefix
      const logPrefix = isSubAgent ? `[SubAgent ${taskId || '?'}]` : '[Agent]';

      // Ensure Session Exists (Multi-Threaded Chat Support)
      if (chatId) {
        const msgCount = this.db.countMessages(chatId);

        // PASSIVE MODE: Messages from 'whatsapp:user' (my text history) should not trigger active agent behaviors
        const isPassiveMode = message.source === 'whatsapp:user' || message.source === 'slack';

        this.db.ensureSession(chatId, message.source);

        // Log Location on New Session
        // DEBUG: Log all metadata to see what's happening
        // console.log(`${logPrefix} Metadata for ${chatId}:`, JSON.stringify(message.metadata));

        if (msgCount === 0 && !isPassiveMode) {
          if (message.metadata?.location) {
            console.log(`${logPrefix} New Session ${chatId} started from location: ${message.metadata.location}`);
          } else {
            console.log(`${logPrefix} New Session ${chatId} started. (No location data in metadata)`);
          }
        }

        // Handle Vault Context Switch
        if (message.metadata?.vaultId) {
          if (message.metadata.vaultId === 'none') {
            this.activeTopics.delete(chatId);
            console.log(`${logPrefix} Chat ${chatId} exited vault context.`);
          } else {
            this.activeTopics.set(chatId, message.metadata.vaultId);
            console.log(`${logPrefix} Chat ${chatId} switched to vault context: ${message.metadata.vaultId}`);
          }
        }

        // Auto-Title Trigger (Background)
        const hasContent = message.content || (message.parts && message.parts.length > 0);

        if (msgCount === 0 && hasContent && message.role === 'user' && !isPassiveMode && !isSubAgent && message.source !== 'scheduler') {
          console.log(`${logPrefix} Triggering Auto-Title for ${chatId}. MsgCount: ${msgCount}`);

          let titleContext = message.content;
          if (!titleContext && message.parts) {
            const textPart = message.parts.find(p => p.text);
            titleContext = textPart ? textPart.text : "User sent media";
          }

          // Don't await - run in background
          this.titleService.autoTitleSession(chatId, titleContext).catch(err => {
            console.error(`${logPrefix} Auto-Title CRASHED for ${chatId}:`, err);
          });
        } else {
          // if (msgCount === 0) console.log(`${logPrefix} Skipped Auto-Title. HasContent: ${!!hasContent}, Role: ${message.role}`);
        }

        // --- SMART FILE ANALYSIS ---
        // Trigger if:
        // 1. User message contains a file (or attachment)
        // 2. We are in a generic context (vaultId is 'none' or undefined)
        // 3. It's a relatively new session (msgCount < 5) to avoid re-analyzing old stuff? Or always?
        // Auto-analyze any NEW user message with non-audio attachments (PDFs, images, text)

        // Suppress for Passive Mode
        if (message.parts && message.role === 'user' && !isPassiveMode && !isSubAgent) {
          const attachment = message.parts.find(p => p.inlineData && !p.inlineData.mimeType.startsWith('audio/') && !p.inlineData.mimeType.startsWith('image/'));
          // Classify anything substantive (PDF, Text, Images) but exclude audio (voice notes)

          const candidatePart = message.parts.find(p =>
            p.inlineData && !p.inlineData.mimeType.startsWith('audio/')
          );

          if (candidatePart) {
            // Run in background to not block chat latency
            this.analysisService.analyzeAttachment(chatId, candidatePart, message.metadata?.vaultId || 'none').catch(console.error);
          }
        }
      }

      // 0. Internal Health Check Interception
      if (message.metadata?.internal_health_check) {
        console.log('[Agent] Handling Internal Health Check. Skipping core logic.');
        const pong = createAssistantMessage('PONG');
        pong.source = 'system';
        // Skip DB Save
        await activeSendCallback(pong);
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
        // ... (existing slash command logic) ...
        const action = commandResult.action;
        console.log(`${logPrefix} User confirmed action: ${action.name}`);
        const result = await this._executeTool(action.name, action.args, message, activeSendCallback, (model, pTokens, cTokens, cached = 0, thoughts = 0) => {
          const cost = calculateCost(model, pTokens, cTokens, cached, thoughts);
          this.db.logTokenUsage({
            model, promptTokens: pTokens, candidateTokens: cTokens,
            totalTokens: pTokens + cTokens, chatId, estimatedCost: cost,
            cachedTokens: cached, thoughtsTokens: thoughts
          });
        });

        executionSummary.toolOutputs.push({ name: action.name, result });

        // Notify user of result
        const reply = createAssistantMessage(`Action **${action.name}** executed.\nResult: \`\`\`json\n${JSON.stringify(result, null, 2).substring(0, 500)}\n\`\`\``);
        reply.metadata = { chatId };
        reply.source = message.source;
        await activeSendCallback(reply);
        executionSummary.replies.push(reply);
        return executionSummary;
      } else if (commandResult === true) {
        // Handled by command handler (e.g. /clear, /cancel)
        return executionSummary;
      }

      // --- WATCHER LOGIC (Enhanced WhatsApp/Slack Intelligence) ---
      // Security: whatsapp:user and slack are PASSIVE (ignored) unless a watcher triggers.
      // Sub-agents skip watcher logic entirely.
      if (!isSubAgent && (message.source?.startsWith('whatsapp') || message.source === 'slack')) {
        const isUserSession = message.source === 'whatsapp:user' || message.source === 'slack';
        const isFromMe = !!message.metadata?.fromMe;
        const contactString = message.metadata?.phoneNumber || message.metadata?.slackUserName || message.metadata?.chatId;
        const groupName = message.metadata?.groupName;
        const msgContent = message.content?.toLowerCase() || '';

        // Fetch active watchers (skip for fromMe — outgoing media only needs extraction)
        const watchers = isFromMe ? [] : this.db.getWatchers('active');
        let triggeredWatcher = null;

        for (const w of watchers) {
          // Check Contact Match (Phone or Group Name)
          // Improved Logic: Handle fuzzy number matching (e.g. 549 vs 54) and cleanup
          let isContactMatch = false;

          if (contactString) { // Message has a phone/sender ID
            // 1. Try Numeric Suffix Match
            const wClean = w.contact_string.replace(/[^0-9]/g, '');
            const msgClean = contactString.replace(/[^0-9]/g, '');

            if (wClean.length >= 8 && msgClean.length >= 8) {
              // Match last 8 digits (reduced from 9 to be safer for varying area codes)
              // 8 digits usually covers the number without area code in many places, or at least substantial overlap.
              // For Argentina: 9 + 351 + 6/7 digits. 
              // 5517678 is 7 digits.
              // 3515517678 is 10 digits.
              // 93515517678 is 11 digits.
              // If we compare last 8: 515517678 vs ...
              // Use endsWith for suffix matching (handles country code prefix differences)

              if (msgClean.endsWith(wClean) || wClean.endsWith(msgClean)) {
                isContactMatch = true;
              } else if (wClean.length >= 9 && msgClean.length >= 9 && wClean.slice(-9) === msgClean.slice(-9)) {
                isContactMatch = true;
              }

            }

            // 2. Fallback to direct string inclusion (handles names or shorter numbers)
            if (!isContactMatch) {
              isContactMatch = w.contact_string.includes(contactString);
            }
          }

          if (!isContactMatch && groupName) {
            // 3. Group Name Match
            isContactMatch = w.contact_string.toLowerCase().includes(groupName.toLowerCase());
          }

          if (isContactMatch) {
            // Check Condition
            // Simple 'contains' logic for now
            if (w.condition === '*' || w.condition.toLowerCase() === 'any' || w.condition.toLowerCase() === 'all') {
              triggeredWatcher = w;
              break;
            } else if (w.condition.startsWith('contains')) {
              // "contains 'dinner'" -> extract "dinner"
              const keyword = w.condition.match(/['"](.*?)['"]/)?.[1];
              if (keyword && msgContent.includes(keyword.toLowerCase())) {
                triggeredWatcher = w;
                break;
              }
            }
            // Fallback: simple substring match of the condition itself
            else if (msgContent.includes(w.condition.toLowerCase())) {
              triggeredWatcher = w;
              break;
            }
          }
        }

        if (isUserSession && !triggeredWatcher) {
          // PASSIVE MODE: Save to DB but DO NOT REPLY.
          const safeMessage = { ...message };

          // Eager Semantic Extraction for Media (1:1 only)
          if (safeMessage.parts && !groupName) { // Skip groups to save tokens
            const mediaParts = safeMessage.parts.filter(p => p.inlineData && (p.inlineData.mimeType.startsWith('audio/') || p.inlineData.mimeType.startsWith('image/')));

            if (mediaParts.length > 0) {
              try {
                // Initialize lite client specifically for low-latency, low-cost extraction
                const { GoogleGenAI } = await this._loadClientLibrary();
                const genAI = new GoogleGenAI({ apiKey: this.config.googleApiKey });
                const liteModel = process.env.WORKER_LITE || process.env.WORKER_FLASH || 'gemini-2.5-flash';

                for (const part of mediaParts) {
                  const isAudio = part.inlineData.mimeType.startsWith('audio/');
                  const prompt = isAudio ? "Transcribe this audio verbatim in the original language." : "Describe this image in detail concisely.";

                  console.log(`${logPrefix} Eagerly extracting semantics for passive 1:1 ${isAudio ? 'audio' : 'image'} (model: ${liteModel})...`);
                  const result = await genAI.models.generateContent({
                    model: liteModel,
                    contents: [{ role: 'user', parts: [part, { text: prompt }] }],
                    config: {
                      thinkingConfig: { thinkingLevel: 'MINIMAL' }
                    }
                  });

                  this.configService.logUsageFromResponse(this.db, liteModel, result, chatId, isAudio ? 'eager_transcribe' : 'eager_describe');

                  const text = result.text;
                  if (text) {
                    const tag = isAudio ? '[Voice Transcript]' : '[Image Description]';
                    safeMessage.content = (safeMessage.content ? safeMessage.content + '\n' : '') + `${tag} ${text}`;
                    console.log(`${logPrefix} Extracted semantics: ${tag} ${text.substring(0, 50)}...`);
                  }
                }
              } catch (e) {
                console.warn(`${logPrefix} Failed to eagerly extract media semantics:`, e.message);
              }
            }
          }

          // OPTIMIZATION: Strip Media Data to save disk space
          if (safeMessage.parts) {
            safeMessage.parts = safeMessage.parts.map(p => {
              if (p.inlineData) {
                return {
                  ...p,
                  inlineData: { ...p.inlineData, data: '[MEDIA_STRIPPED_PASSIVE]' }
                };
              }
              return p;
            });
          }

          // By default, we DO NOT save passive messages to main DB to avoid clutter/bloat.
          // The Agent can "pull" history on demand using readChatHistory tool.
          if (this.settings.save_passive_messages) {
            this.db.saveMessage(safeMessage);
          }
          // Log suppressed per user request
          // console.log(`${logPrefix} Passive Mode (whatsapp:user): Message from ${contactString} saved. No watcher triggered. Ignoring.`);

          // --- AUTOPILOT LOGIC (skip for fromMe — we don't want to draft replies to ourselves) ---
          if (!isFromMe) {
            try {
              this.impersonationService.handleMessage(chatId, message, contactString);
            } catch (e) {
              console.error('[Agent] Autopilot failed:', e.message);
            }
          }

          return executionSummary; // Exit early
        }

        if (triggeredWatcher) {
          console.log(`${logPrefix} Watcher TRIGGERED! ID: ${triggeredWatcher.id}, Instruction: "${triggeredWatcher.instruction}"`);

          // Watchers stay active across triggers; update last trigger timestamp
          this.db.updateWatcher(triggeredWatcher.id, { lastTriggeredAt: new Date().toISOString() });

          // Construct System Alert to force Agent Action
          // We replace the original content with the Instruction + Context
          // But we keep the original message in DB for history?
          // "Passive Mode" logic above saved it.
          // If it IS triggered, we proceed.

          this.db.saveMessage(message);

          // HIJACK SEND CALLBACK FOR WATCHER: Suppress/Redirect replies
          console.log('[Agent] WATCHER DETECTED. Hijacking activeSendCallback.');
          const upstreamCallback = activeSendCallback;
          activeSendCallback = async (reply) => {
            // 1. Log suppression
            console.log(`${logPrefix} WATCHER SUPPRESSION: Intercepted reply to ${contactString} (triggered by watcher).`);
            console.log(`${logPrefix} Content:`, reply.content);

            // 2. Redirect to Admin? (Optional - fetch adminId from config)
            const adminChatId = this.settings.admin_chat_id;
            console.log(`${logPrefix} Admin Chat ID setting: ${adminChatId}`);

            if (adminChatId && reply.content) {
              console.log(`${logPrefix} Redirecting suppressed reply to ADMIN (${adminChatId})`);
              const adminReply = { ...reply, metadata: { ...reply.metadata, chatId: adminChatId } };
              // Prefix to explain context
              adminReply.content = `[WATCHER: ${contactString}]\n${reply.content}`;

              console.log('Upstream callback identity check:', !!upstreamCallback.mock, upstreamCallback.name);
              await upstreamCallback(adminReply);
              console.log('Upstream called.');
            } else {
              console.log(`${logPrefix} Suppressed reply (No admin_chat_id configured).`);
            }

            // 3. Do NOT send to original sender.
          };
          console.log('[Agent] activeSendCallback has been replaced.');

          // Create a pseudo-message for the Agent to ACT on
          message.content = `SYSTEM_WATCHER_ALERT: A message from ${contactString} ("${message.content}") matched watcher conditions. \nINSTRUCTION: ${triggeredWatcher.instruction} \n\nIMPORTANT: DO NOT REPLY TO THE SENDER directly. They are a contact, not the user. \n- If you need to send them a message, use the 'sendMessage' tool explicitly.\n- If you need to confirm the action, just say "Done" and I will redirect it to the Admin.`;
          message.role = 'user'; // Treat as a command from me
          // Proceed to normal flow...
        }
      }

      // 2. Rate Limiting
      if (!(await this.rateLimiter.check(message, this.interface)) && !isSubAgent) {
        return executionSummary;
      }

      // 3. Save User Message (If not already saved by Passive Mode logic)
      // We moved saveMessage up in the Passive Mode block.
      // If we are here, it's either:
      // a) Not whatsapp
      // b) whatsapp:assistant (normal command)
      // c) whatsapp:user AND triggered watcher

      // If (c), we saved it inside the block.
      // If (b) or (a), we need to save it.
      // saveMessage uses INSERT with generated UUID — safe to call without deduplication concern

      if (!message.source?.startsWith('whatsapp:user') && message.source !== 'slack') {
        this.db.saveMessage(message);
      }

      await reportProgress('Routing...');

      // --- ROUTING ---
      let e2eCost = 0; // Track total cost for this request
      let e2eTokens = 0; // Track total tokens
      let decision;

      // forceModel bypass: skip router when model is explicitly set (e.g. scheduled jobs, sub-agents)
      const forceModel = message.metadata?.forceModel;
      if (forceModel && ['FLASH', 'LITE', 'PRO', 'IMAGE'].includes(forceModel.toUpperCase())) {
        decision = { model: forceModel.toUpperCase(), toolMode: 'STANDARD', reason: `forceModel override (${forceModel})` };
        console.log(`${logPrefix} Router BYPASSED — forceModel: ${decision.model}`);
        this.db.logMetric('latency_router', 0, { model: decision.model, chatId, runId, bypassed: true });
      } else {
        console.time(`${logPrefix} Router Duration`);
        const routerStart = Date.now();

        // Get brief history for context (last 3 messages)
        const routingHistory = this.db.getHistoryForChat(chatId, 3);

        // STICKY ROUTING: Check if we were using PRO recently
        const lastModelMsg = routingHistory.find(m => m.role === 'model');
        const lastModel = lastModelMsg?.metadata?.model;
        const lastModelTimestamp = lastModelMsg?.timestamp;
        let timeSinceLastModel = 0;
        if (lastModelTimestamp) {
          timeSinceLastModel = Date.now() - new Date(lastModelTimestamp).getTime();
        }

        // Pass the primary content or parts to router
        decision = await this.router.route(message.parts || message.content, routingHistory, lastModel, timeSinceLastModel, message.source);
        const routerDuration = Date.now() - routerStart;
        console.timeEnd(`${logPrefix} Router Duration`);

        this.db.logMetric('latency_router', routerDuration, { model: decision.model, chatId, runId });
      }
      console.log(`${logPrefix} Routing to: ${decision.model}`);

      // --- GROK / EXTERNAL MODEL OVERRIDE ---
      if (message.metadata?.model && message.metadata.model.startsWith('grok')) {
        const targetModel = message.metadata.model;
        console.log(`${logPrefix} Routing Override: Using ${targetModel}`);

        // JIT Init for xAI if key exists but client doesn't
        if (!this.xaiClient && this.settings['provider:xai']?.apiKey) {
          const apiKey = this.settings['provider:xai'].apiKey;
          try {
            const OpenAI = require('openai');
            this.xaiClient = new OpenAI({
              apiKey: apiKey,
              baseURL: 'https://api.x.ai/v1'
            });
            console.log('[Agent] xAI Client Initialized JIT (Grok)');
          } catch (e) {
            console.error('[Agent] Failed to init xAI client JIT:', e);
          }
        }

        if (!this.xaiClient) {
          const errReply = createAssistantMessage('System: Grok is not configured. Please set API Key in Settings.');
          await activeSendCallback(errReply);
          return executionSummary;
        }

        await reportProgress(`Thinking(${targetModel})...`);
        const history = this.db.getHistoryForChat(chatId, 20); // Static window for now

        // --- PREPARE SYSTEM PROMPT FOR GROK ---
        const contextQuery = message.content || (message.parts ? message.parts.map(p => p.text).join(' ') : '');
        const facts = this.db.getFactsFormatted(contextQuery);
        const activeGoals = this.db.getPendingGoals().map(g => `- [${g.id}] ${g.description}`).join('\n');

        let vaultContext = null;
        const activeTopic = this.activeTopics.get(chatId);
        if (activeTopic) {
          try { vaultContext = await this.vaults.readVaultPage(activeTopic, 'index.md'); } catch (e) { }
        }

        const timeZone = process.env.TZ || 'America/Argentina/Buenos_Aires';
        const timeString = new Date().toLocaleString('en-US', { timeZone, timeZoneName: 'short' }) + ` (${timeZone})`;

        // Use latest skill context
        const skillsContext = this.skillService.getGlobalInstructions();
        let grokSystemPrompt = getSystemInstruction(timeString, activeGoals, facts, { codingMode: true, vaultContext, skillsContext });

        // Add Tool Manifest since Grok can't see definitions natively yet
        grokSystemPrompt += `\n\n ** AVAILABLE TOOLS(You cannot execute them directly, but you know they exist):**\n` +
          `- googleSearch: Search the web.\n` +
          `- replyWithAudio: Speak to the user.\n` +
          `- rememberFact / getFact: Memory.\n` +
          `- addGoal / completeGoal: Task tracking.\n` +
          `- Smart Home: Control lights, vacuum, etc.\n`;

        this.currentSystemPrompt = grokSystemPrompt;

        const stream = await this._generateStreamGrok(this.xaiClient, targetModel, message.content, history, chatId);

        // Handle stream and callback similar to _generateStream but adapted
        // _generateStreamGrok handles streaming and broadcasting directly
        // processMessage expects a `candidates` object format

        // _generateStreamGrok will handle broadcasting internally and return full text for saving db.

        const fullContent = await stream; // Await the promise which resolves to final text

        const reply = createAssistantMessage(fullContent);
        reply.source = message.source;
        reply.metadata = { model: targetModel, chatId };

        await activeSendCallback(reply);
        executionSummary.replies.push(reply);

        // Save to DB
        this.db.saveMessage(reply);

        return executionSummary;
      }

      // --- BYPASS: DIRECT IMAGE GENERATION ---
      if (decision.model === 'IMAGE') {
        console.log('[Agent] Executing Direct Image Generation Bypass');

        let prompt = message.content;
        // Handle multimodal prompt extraction if needed, but usually image gen prompt is text
        if (message.parts) {
          prompt = message.parts.map(p => p.text).join(' ');
        }

        const toolResult = await this._executeTool('generateImage', { prompt: prompt }, message, activeSendCallback, (model, pTokens, cTokens) => {
          // Image gen usually flat cost or different metric, but if we had tokens we'd track here.
          // For now, no-op or specific image cost logic if needed.
        });
        executionSummary.toolOutputs.push({ name: 'generateImage', result: toolResult });

        // Optionally send a text confirmation
        const reply = createAssistantMessage('Image generated.');
        reply.metadata = { chatId: message.metadata?.chatId };
        reply.source = message.source;
        await activeSendCallback(reply);
        executionSummary.replies.push(reply);

        // --- HISTORY INJECTION [FIX] ---
        // Simulate standard Tool Use flow so future context knows this was handled.

        // 1. Synthetic Model Turn (Function Call)
        this.db.saveMessage({
          role: 'model',
          parts: [{ functionCall: { name: 'generateImage', args: { prompt } } }],
          metadata: { chatId: message.metadata?.chatId },
          source: message.source
        });

        // 2. Synthetic Function Turn (Function Response)
        this.db.saveMessage({
          role: 'function',
          parts: [{
            functionResponse: {
              name: 'generateImage',
              response: { result: { info: 'Image generated successfully.' } }
            }
          }],
          metadata: { chatId: message.metadata?.chatId },
          source: message.source
        });

        // 3. Assistant Final Response
        this.db.saveMessage({
          role: 'assistant',
          content: 'Image generated.',
          metadata: { chatId: message.metadata?.chatId },
          source: message.source
        });

        return executionSummary;
      }

      const selectedModel = decision.model === 'FLASH'
        ? this.configService.getModel('FLASH')
        : decision.model === 'LITE'
          ? this.configService.getModel('LITE')
          : this.configService.getModel('PRO');

      console.log(`${logPrefix} Routing to Model: ${selectedModel}`);
      await reportProgress(`Thinking(${selectedModel})...`);

      // --- EXPERIMENTAL: Adaptive Context Window ---
      // Flash models (simple tasks) need less context. Pro models (reasoning) need more.


      // --- HYDRATION ---
      const historyLimit = (decision.model === 'FLASH' || decision.model === 'IMAGE') ? 10 : 50;
      console.log(`${logPrefix} Fetching history(Smart Context) for model: ${decision.model} `);

      // --- HYDRATION (Smart Context) ---
      const history = await this.smartContext.getContext(chatId, decision.model);

      const historyChars = JSON.stringify(history).length;
      console.log(`${logPrefix} [Context] History loaded: ${history.length} messages.Size: ~${historyChars} chars(~${Math.round(historyChars / 4)} tokens).`);

      // --- TOOLS MERGE ---
      const mcpTools = await this.mcp.getTools();

      // Transform MCP tools to Gemini Format if not already compliant
      let externalTools = mcpTools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }));

      // Flatten all internal tool declarations from toolDefinitions array
      // Strip 'category' field (used only for scoping, not part of Gemini schema)
      let internalTools = toolDefinitions.flatMap(td => td.functionDeclarations || [])
        .map(({ category, ...rest }) => rest);

      // Sub-agent tool filtering: restrict to allowed tools if specified
      if (message.metadata?.isSubAgent && message.metadata?.allowedTools) {
        const allowed = new Set(message.metadata.allowedTools);
        internalTools = internalTools.filter(t => allowed.has(t.name));
      }

      // Sub-agents cannot spawn other sub-agents (remove from available tools)
      if (message.metadata?.isSubAgent) {
        internalTools = internalTools.filter(t => t.name !== 'spawnAgent');
      }

      // Scheduled job tool filtering: restrict to auto-scoped tools if available
      if (message.source === 'scheduler' && message.metadata?.allowedTools) {
        const allowed = new Set(message.metadata.allowedTools);
        internalTools = internalTools.filter(t => allowed.has(t.name));
        externalTools = externalTools.filter(t => allowed.has(t.name));
        console.log(`${logPrefix} Scheduler tool scope applied: ${allowed.size} tools allowed (internal: ${internalTools.length}, external: ${externalTools.length})`);
      }

      const allTools = [
        ...internalTools,
        ...externalTools
      ];

      // construct the tools object for Gemini
      // --- HYBRID SEARCH STRATEGY ---
      // 1. Native Search (Grounding): Faster, Cheaper, Better Citations. BUT cannot mix with other tools (e.g. replyWithAudio).
      // 2. Standard Mode (Polyfill): Slower, separate session. BUT allows mixing search + text-to-speech.

      const isAudioContext =
        // Input is Audio
        (message.content === '[Voice]' || (message.parts && message.parts.some(p => p.inlineData?.mimeType?.startsWith('audio/')))) ||
        // Output explicitly requested as Audio (e.g. iOS Shortcut)
        ['iphone', 'ios_shortcut'].includes(message.source) ||
        message.metadata?.replyMode === 'audio';

      let useNativeSearch = false; // Default baseline

      // Load Configuration from Unified Settings (agent_settings)
      // Fallback to KV store (legacy) if not present in settings
      const searchConfig = this.settings.search_strategy || this.db.getKey('config:search_strategy') || { mode: 'HYBRID' };
      const strategyMode = searchConfig.mode || 'HYBRID';

      if (decision.toolMode === 'SEARCH') {
        if (strategyMode === 'NATIVE_ONLY') {
          console.log('[Agent] Mode: SEARCH. Config forced NATIVE_ONLY.');
          useNativeSearch = true;
        } else if (strategyMode === 'STANDARD_ONLY') {
          console.log('[Agent] Mode: SEARCH. Config forced STANDARD_ONLY.');
          useNativeSearch = false;
        } else {
          // HYBRID (Default Logic)
          if (isAudioContext) {
            console.log('[Agent] Mode: SEARCH requested, but Audio Context detected. Forcing STANDARD mode (Polyfill Search + TTS).');
            useNativeSearch = false;
          } else {
            console.log('[Agent] Mode: SEARCH (Native Google Grounding). Text-only context.');
            useNativeSearch = true;
          }
        }
      }

      let geminiTools;

      if (useNativeSearch) {
        // Exclusive Mode
        console.log('[Agent] Tool Mode: NATIVE SEARCH (Exclusive). Other tools disabled.');
        geminiTools = [{ googleSearch: {} }];
      } else {
        // Standard Function Calling (includes 'googleSearch' polyfill if needed)
        console.log(`${logPrefix} Mode: STANDARD(Function Calling) - Enforced for ${decision.toolMode}`);
        // const toolNames = allTools.map(t => t.name).join(', ');
        // console.log(`${ logPrefix } Available Tools for Model: [${ toolNames }]`);
        geminiTools = [{ functionDeclarations: allTools }];
      }

      // Build System Instruction
      const pendingGoals = this.db.getPendingGoals()
        .map(g => `- [${g.id}] ${g.description} `)
        .join('\n            ');

      // Fetch Memory/Facts
      const contextQuery = message.content || (message.parts ? message.parts.map(p => p.text).join(' ') : '');
      const facts = this.db.getFactsFormatted(contextQuery);
      const activeGoals = this.db.getPendingGoals().map(g => `- [${g.id}] ${g.description} `).join('\n');

      // Fetch Vault Context if active
      let vaultContext = null;
      const activeTopic = this.activeTopics.get(chatId);
      if (activeTopic) {
        try {
          vaultContext = await this.vaults.readVaultPage(activeTopic, 'index.md');
        } catch (e) {
          console.warn(`${logPrefix} Failed to read vault context for ${activeTopic}: `, e);
        }
      }

      // Formatter for System Time
      const timeZone = process.env.TZ || 'America/Argentina/Buenos_Aires';
      const timeString = new Date().toLocaleString('en-US', { timeZone, timeZoneName: 'short' }) + ` (${timeZone})`;

      // Use latest skill context
      const skillsContext = this.skillService.getGlobalInstructions();
      let systemInstruction = getSystemInstruction(
        timeString,
        activeGoals,
        facts,
        { codingMode: true, vaultContext, skillsContext } // Coding mode enabled by default for now, could be dynamic
      );

      console.log(`${logPrefix} [Context] System Instruction Size: ~${systemInstruction.length} chars(~${Math.round(systemInstruction.length / 4)} tokens).`);
      // --- TONE MATCHING (Impersonation Mode) ---
      // If we are acting on behalf of the user (whatsapp:user), we must sound like them.
      // We add this instruction globally so the Agent knows how to behave if asked to "act as me" or use the 'user' session.
      systemInstruction += `\n
      \n === IMPERSONATION & TONE MATCHING ===
        IF you are asked to draft a message for the user, or if you are replying via the 'user'(whatsapp: user) session:
      1. ** Analyze History **: Look at the user's previous messages in the chat history.
      2. ** Match Tone **: Mimic their style, brevity, capitalization(lowercase ?), and emoji usage.
      3. ** Be Natural **: Do not sound like an AI.Use "I", not "Deedee".
      --------------------------------
      `;


      // In-Context User Location
      if (message.metadata?.location) {
        systemInstruction += `\n\n**USER LOCATION**: The user is currently in **${message.metadata.location}**. Use this for context (weather, time, local queries) if queried.`;
      }

      if (['iphone', 'ios_shortcut'].includes(message.source)) {
        systemInstruction += `\n
            **DICTATION SAFEGUARD**: You are receiving input from iOS Voice Dictation. It is prone to errors.
            - If the user's request is AMBIGUOUS, resembles gibberish, or matches a tool only weakly (e.g. "turn on the light" but no room specified, or "play movie" but name is garbled), DO NOT EXECUTE THE TOOL.
            - Instead, ASK FOR CLARIFICATION: "Did you say [interpreted text]?" or "Which light?".
            - ONLY execute tools if the intent is crystal clear.
        `;
      }

      // REPLY MODE INSTRUCTION
      const replyMode = message.metadata?.replyMode || 'auto';

      // Force Audio for iOS Shortcut / iPhone to ensure consistent behavior
      const isIOS = ['iphone', 'ios_shortcut'].includes(message.source);

      if (replyMode === 'text') {
        systemInstruction += `\n
            **OUTPUT RESTRICTION**: The user has explicitly requested a TEXT-ONLY response.
            - DO NOT call the 'replyWithAudio' tool.
            - Provide your response purely as text.
        `;
      } else if (isIOS || (replyMode === 'audio' && !message.parts)) {
        systemInstruction += `\n
            **OUTPUT RESTRICTION**: The user is interacting via Voice/Audio.
            - YOU MUST call the 'replyWithAudio' tool to speak your response.
            - DO NOT just return text.
        `;
      }

      // 2. Send Message to Gemini (with Retry Logic)
      const MAX_EMPTY_RETRIES = 2;
      let retryCount = 0;
      let response;
      let session;

      while (retryCount <= MAX_EMPTY_RETRIES) {
        // Initialize Stateless Chat Session (Re-created per retry to avoid history pollution)
        if (retryCount > 0) {
          await reportProgress(`Retrying connection (${retryCount}/${MAX_EMPTY_RETRIES})...`);
          // Add small delay
          await new Promise(r => setTimeout(r, 1000));
        } else {
          await reportProgress('Hydrating memory...');
        }

        session = this.client.chats.create({
          model: selectedModel,
          config: {
            tools: geminiTools,
            systemInstruction: systemInstruction,
          },
          history: history
        });

        const timerLabel = `[Agent] Model Response (${selectedModel}) - ${Date.now()}`;
        console.time(timerLabel);
        if (retryCount === 0) await reportProgress('Generating response...');

        const modelStart = Date.now();
        try {
          // STREAMING IMPLEMENTATION
          response = await this._generateStream(session, message.parts || message.content, chatId, message.source);

          const modelDuration = Date.now() - modelStart;
          console.timeEnd(timerLabel);
          this.db.logMetric('latency_model', modelDuration, { model: selectedModel, chatId, runId });

          // Validation
          if (!response) throw new Error('Response object is undefined.');
          const initialCandidates = response.candidates || [];
          const firstCandidate = initialCandidates[0];
          const parts = firstCandidate?.content?.parts || [];

          const hasFunctionCall = parts.some(p => p.functionCall);
          const hasText = parts.some(p => p.text && p.text.trim().length > 0);

          if (hasFunctionCall || hasText) {
            break; // Valid response
          }

          console.warn(`${logPrefix} Empty response detected (FinishReason: ${firstCandidate?.finishReason}). Retrying...`);
        } catch (e) {
          console.warn(`${logPrefix} Model request failed: ${e.message}. Retrying...`);
          // DEBUG: Log full object if possible
          if (response) {
            console.log('[Agent] Full Response Object:', JSON.stringify(response, null, 2));
          }
          if (retryCount === MAX_EMPTY_RETRIES) throw e; // Re-throw on last attempt
        }

        retryCount++;
      }

      if (retryCount > MAX_EMPTY_RETRIES && !response) {
        throw new Error('Failed to get valid response from model after retries.');
      }

      // USAGE LOGGING
      if (response.usageMetadata) {
        const { promptTokenCount, candidatesTokenCount, totalTokenCount, cachedContentTokenCount, thoughtsTokenCount } = response.usageMetadata;
        const cost = calculateCost(selectedModel, promptTokenCount, candidatesTokenCount, cachedContentTokenCount || 0, thoughtsTokenCount || 0);
        e2eCost += cost;
        e2eTokens += totalTokenCount;

        console.log(`[Tokens] P: ${promptTokenCount} | C: ${candidatesTokenCount} | Cached: ${cachedContentTokenCount || 0} | Think: ${thoughtsTokenCount || 0} | Total: ${totalTokenCount} | Cost: $${cost.toFixed(6)}`);

        this.db.logTokenUsage({
          model: selectedModel,
          promptTokens: promptTokenCount,
          candidateTokens: candidatesTokenCount,
          totalTokens: totalTokenCount,
          chatId,
          estimatedCost: cost,
          cachedTokens: cachedContentTokenCount || 0,
          thoughtsTokens: thoughtsTokenCount || 0
        });
      }

      // 3. Handle Function Calls Loop
      let functionCalls = getFunctionCalls(response);


      const MAX_LOOPS_DEFAULT = parseInt(process.env.MAX_TOOL_LOOPS || '15');
      const MAX_LOOPS_BROWSER = parseInt(process.env.MAX_TOOL_LOOPS_BROWSER || '25');
      const MAX_SAME_TOOL_CALLS = 3; // Same tool name (non-browser) = likely stuck
      const MAX_IDENTICAL_CALLS = 3; // Same tool + same args = definitely stuck
      let loopCount = 0;
      let hasBrowserSession = false; // Escalate limit when browser tools are used
      const toolCallTracker = {}; // toolName -> count (per-tool-name, non-browser only)
      const identicalCallTracker = {}; // full signature -> count (any tool)

      while (functionCalls && functionCalls.length > 0) {
        // CHECK STOP FLAG
        if (this.stopFlags.has(chatId) || this.stopFlags.has('GLOBAL_STOP')) {
          console.log(`${logPrefix} Stop flag detected for chat ${chatId}. Breaking loop.`);
          await activeSendCallback(createAssistantMessage('🛑 Execution stopped by user.'));
          this.stopFlags.delete(chatId);
          // Do NOT delete GLOBAL_STOP here, so it hits other concurrent loops.
          // It will be cleared on next user input.
          break;
        }

        loopCount++;
        const maxLoops = hasBrowserSession ? MAX_LOOPS_BROWSER : MAX_LOOPS_DEFAULT;
        if (loopCount > maxLoops) {
          console.warn(`${logPrefix} Max tool loop limit reached (${maxLoops}). Breaking.`);
          await activeSendCallback(createAssistantMessage('I am stuck in a loop. Stopping now.'));
          break;
        }

        // Periodic Feedback (every 3rd loop, starting at 3)
        if (loopCount > 1 && loopCount % 3 === 0) {
          const thinkText = getThinkingMessage(functionCalls);
          if (thinkText) {
            const updateMsg = createAssistantMessage(`Still working... (${thinkText})`);
            updateMsg.metadata = { chatId: message.metadata?.chatId };
            updateMsg.source = message.source;
            await activeSendCallback(updateMsg).catch(err => console.error('[Agent] Failed to send update msg:', err));
          }
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
        // FIX: Deduplicate tool calls (Model might hallucinate duplicates)
        // EXCEPTION: Browser tools are allowed to have duplicates (e.g. pressing ArrowDown twice)
        const uniqueCalls = [];
        const seenCalls = new Set();
        for (const call of functionCalls) {
          const signature = `${call.name}:${JSON.stringify(call.args)}`;
          if (!seenCalls.has(signature) || call.name?.includes('browser_')) {
            seenCalls.add(signature);
            uniqueCalls.push(call);
          } else {
            console.warn(`${logPrefix} Dropped duplicate tool call: ${call.name}`);
          }
        }
        functionCalls = uniqueCalls;

        const hasBrowserTools = functionCalls.some(c => c.name && c.name.includes('browser_'));
        if (hasBrowserTools) {
          hasBrowserSession = true; // Escalate loop limit for this session
          console.log(`${logPrefix} Processing ${functionCalls.length} tool calls sequentially (browser interactions).`);
        } else {
          console.log(`${logPrefix} Processing ${functionCalls.length} tool calls in parallel.`);
        }

        // LOOP DETECTION: Two-tier approach (non-browser tools ONLY)
        // Browser tools (click, type, snapshot, screenshot) are fully exempt — they legitimately
        // repeat with identical args (e.g. screenshot has no args). The MAX_LOOPS_BROWSER limit
        // is the safety net for browser sessions.
        // Tier 1: Per-tool-name tracking (catches searchPerson("diego"), searchPerson("Die"), etc.)
        // Tier 2: Identical call tracking (catches exact same call repeated — definitely stuck)
        for (const call of functionCalls) {
          const toolName = call.name || '';
          if (toolName.includes('browser_')) continue; // Browser tools exempt from all loop detection

          const sig = `${toolName}:${JSON.stringify(call.args)}`;

          // Tier 1: Per-tool-name
          toolCallTracker[toolName] = (toolCallTracker[toolName] || 0) + 1;

          // Tier 2: Identical signature
          identicalCallTracker[sig] = (identicalCallTracker[sig] || 0) + 1;
        }

        // Check for loops and inject warnings into tool results
        // Collect blocked sigs first, then filter — avoid mutating array mid-iteration
        const sigsToBlock = new Set();
        const loopWarnings = [];
        for (const call of functionCalls) {
          const toolName = call.name || '';
          if (toolName.includes('browser_')) continue; // Browser tools exempt

          const sig = `${toolName}:${JSON.stringify(call.args)}`;

          // Tier 2: Identical call — hard block
          if (identicalCallTracker[sig] >= MAX_IDENTICAL_CALLS) {
            console.warn(`${logPrefix} Stuck loop: ${toolName} called ${identicalCallTracker[sig]} times with identical args`);
            sigsToBlock.add(sig);
            loopWarnings.push(`"${toolName}" called ${identicalCallTracker[sig]} times with the exact same arguments`);
          }
          // Tier 1: Same tool name — warn via tool result
          else if (toolCallTracker[toolName] >= MAX_SAME_TOOL_CALLS) {
            console.warn(`${logPrefix} Loop detection: ${toolName} called ${toolCallTracker[toolName]} times`);
            call._loopWarning = `⚠️ You have called "${toolName}" ${toolCallTracker[toolName]} times. STOP repeating this tool with parameter variations and try a DIFFERENT approach.`;
          }
        }

        // Apply Tier 2 blocks after iteration completes
        if (sigsToBlock.size > 0) {
          functionCalls = functionCalls.filter(c => !sigsToBlock.has(`${(c.name || '')}:${JSON.stringify(c.args)}`));
        }

        if (functionCalls.length === 0 && loopWarnings.length > 0) {
          await activeSendCallback(createAssistantMessage(`Stopped: ${loopWarnings.join('; ')}. Try a different approach.`));
          break;
        }
        if (functionCalls.length === 0) break;
        // console.log(JSON.stringify(functionCalls)); // PREVENT SPAM
        const toolNames = functionCalls.map(c => (c.name || '').replace('default_api:', '')).join(', ');
        await reportProgress(`Executing ${functionCalls.length} tools: ${toolNames}...`);

        // 1. Start Global Thinking Timer (for the batch)
        let thinkTimer = setTimeout(async () => {
          const thinkText = getThinkingMessage(functionCalls);
          if (thinkText) {
            const thinkingMsg = createAssistantMessage(`Thinking... (${thinkText})`);
            thinkingMsg.metadata = { chatId: message.metadata?.chatId };
            thinkingMsg.source = message.source;
            await activeSendCallback(thinkingMsg).catch(err => console.error('[Agent] Failed to send thinking msg:', err));
          }
        }, 2500);

        // 2. Execute All Tools
        const executeToolCall = async (call) => {
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
              console.log(`${logPrefix} Action ${executionName} requires confirmation.`);
              this.confirmationManager.store(message.metadata?.chatId, executionName, call.args);

              // Notify user specifically
              const confirmMsg = createAssistantMessage(`🛑 **Safety Check**: I want to execute \`${executionName}\`.\n\nArgs: \`${JSON.stringify(call.args)}\`\n\n${guard.message}\n\nReply **/confirm** to proceed or **/cancel** to stop.`);
              confirmMsg.metadata = { chatId: message.metadata?.chatId };
              confirmMsg.source = message.source;
              await activeSendCallback(confirmMsg).catch(console.error);

              toolResult = { info: `Action PAUSED. ${guard.message} User must confirm.` };
            } else {
              // Execute normally
              toolResult = await this._executeTool(executionName, call.args, message, activeSendCallback, (model, pTokens, cTokens, cached = 0, thoughts = 0) => {
                const cost = calculateCost(model, pTokens, cTokens, cached, thoughts);
                e2eCost += cost;
                e2eTokens += (pTokens + cTokens);
                console.log(`[Tokens-Polyfill] P: ${pTokens} | C: ${cTokens} | Cached: ${cached} | Think: ${thoughts} | Cost: $${cost.toFixed(6)}`);

                this.db.logTokenUsage({
                  model, promptTokens: pTokens, candidateTokens: cTokens,
                  totalTokens: pTokens + cTokens, chatId, estimatedCost: cost,
                  cachedTokens: cached, thoughtsTokens: thoughts
                });
              });
            }
          } catch (toolErr) {
            console.warn(`${logPrefix} Tool execution failed (${executionName}): ${toolErr.message}`);
            toolResult = { error: `Tool execution failed: ${toolErr.message}` };
          }

          if (toolResult === undefined || toolResult === null) {
            toolResult = { info: 'No output from tool execution.' };
          }

          return { call, executionName, result: toolResult };
        };

        let results = [];
        if (hasBrowserTools) {
          // Sequential execution for UI reliability
          for (const call of functionCalls) {
            results.push(await executeToolCall(call));
          }
        } else {
          // Parallel execution for speed
          const toolPromises = functionCalls.map(executeToolCall);
          results = await Promise.all(toolPromises);
        }

        clearTimeout(thinkTimer);

        // 3. Process Results & Build Response
        const functionResponseParts = [];
        const dbFunctionResponseParts = [];

        for (const { call, executionName, result } of results) {
          // Capture to Summary
          executionSummary.toolOutputs.push({ name: executionName, result });

          // Sanitize for DB AND Model to prevent Context Pollution
          let dbToolResult = result;
          if (executionName === 'generateImage') {
            // Gemini does NOT need the base64. It just needs success.
            dbToolResult = { info: 'Image generated and sent to user.' };
          } else if (result && result.image_base64 && result.image_base64.length > 500) {
            dbToolResult = { ...result, image_base64: '<BASE64_IMAGE_TRUNCATED>' };
          }

          // Sanitize MCP tool results (strip email bloat, cap oversized results)
          dbToolResult = sanitizeToolResult(executionName, dbToolResult);

          // Log the SANITIZED result (post-cleanup) to keep console logs readable
          const resultStr = JSON.stringify(result);
          const sanitizedStr = JSON.stringify(dbToolResult);
          let logResult;
          if (typeof dbToolResult === 'string' && dbToolResult.length > 1000) {
            logResult = dbToolResult.substring(0, 200) + '... [TRUNCATED STRING]';
          } else if (sanitizedStr.length > 1000) {
            logResult = sanitizedStr.substring(0, 1000) + '... [TRUNCATED]';
          } else {
            logResult = sanitizedStr;
          }
          console.log(`${logPrefix} Tool Result (${executionName}): ~${resultStr.length} chars${resultStr.length !== sanitizedStr.length ? ` → ${sanitizedStr.length} sanitized` : ''}. Content:`, logResult);

          // Notify on tool result truncation
          if (dbToolResult?._sanitizer?.truncated) {
            const chatId = message.metadata?.chatId;
            this.notifications.create({
              type: 'tool_truncation',
              severity: 'warning',
              title: `Tool output truncated: ${executionName}`,
              message: `"${executionName}" returned ${dbToolResult._sanitizer.originalChars.toLocaleString()} chars, truncated to ${dbToolResult._sanitizer.maxChars.toLocaleString()}. Some data may have been lost.`,
              metadata: {
                toolName: executionName,
                originalChars: dbToolResult._sanitizer.originalChars,
                maxChars: dbToolResult._sanitizer.maxChars,
                chatId,
                source: message.source,
                link: chatId ? `/system/history?chatId=${encodeURIComponent(chatId)}` : '/system/history',
              }
            });
          }

          // Inject loop warning into tool result so the model sees it
          if (call._loopWarning && typeof dbToolResult === 'object' && dbToolResult !== null) {
            dbToolResult = { ...dbToolResult, _loopWarning: call._loopWarning };
          }

          // Build API Payload (Send CLEAN result to Model)
          // SDK Requirement: 'response' must be an object map.
          let apiResponse = dbToolResult;
          if (typeof dbToolResult !== 'object' || dbToolResult === null || Array.isArray(dbToolResult)) {
            apiResponse = { result: dbToolResult };
          }

          // FIX: Ensure response is not empty to avoid SDK errors (ContentUnion is required)
          if (apiResponse && typeof apiResponse === 'object' && Object.keys(apiResponse).length === 0) {
            console.warn(`${logPrefix} Tool ${call.name} returned empty object. Injecting fallback.`);
            apiResponse = { info: "Tool executed successfully but returned no output." };
          }

          functionResponseParts.push({
            functionResponse: {
              name: call.name,
              response: apiResponse
            }
          });

          // Build DB Payload
          dbFunctionResponseParts.push({
            functionResponse: {
              name: call.name,
              response: apiResponse
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

        try {
          // FIX: Pass parts directly
          const payload = functionResponseParts;

          // ENABLE STREAMING for Tool Responses
          // This allows "Thinking..." or large function arguments (JSON) to be visible to the user
          response = await this._generateStream(session, payload, chatId, message.source);

        } catch (e) {
          console.error('[Agent] Tool response failed:', e);
          console.log('[Agent] FAILING PAYLOAD (functionResponseParts):', JSON.stringify(functionResponseParts, null, 2));
          throw e; // Re-throw to trigger retry logic if needed
        }

        console.timeEnd(toolTimerLabel);

        // USAGE LOGGING (Tool Loop)
        if (response.usageMetadata) {
          const { promptTokenCount, candidatesTokenCount, totalTokenCount, cachedContentTokenCount, thoughtsTokenCount } = response.usageMetadata;
          const cost = calculateCost(selectedModel, promptTokenCount, candidatesTokenCount, cachedContentTokenCount || 0, thoughtsTokenCount || 0);
          e2eCost += cost;
          e2eTokens += totalTokenCount;

          console.log(`[Tokens-Tool] P: ${promptTokenCount} | C: ${candidatesTokenCount} | Cached: ${cachedContentTokenCount || 0} | Think: ${thoughtsTokenCount || 0} | Total: ${totalTokenCount} | Cost: $${cost.toFixed(6)}`);

          this.db.logTokenUsage({
            model: selectedModel,
            promptTokens: promptTokenCount,
            candidateTokens: candidatesTokenCount,
            totalTokens: totalTokenCount,
            chatId,
            estimatedCost: cost,
            cachedTokens: cachedContentTokenCount || 0,
            thoughtsTokens: thoughtsTokenCount || 0
          });
        }

        // Re-check for recursive function calls
        functionCalls = getFunctionCalls(response);
      }

      // 4. Final Text Response
      // SDK might expose text via method or property depending on version/response type
      let text = '';
      if (typeof response.text === 'function') {
        try {
          text = response.text();
          console.log(`[Agent] Extracted text: "${text}"`);
        } catch (e) {
          console.warn('[Agent] Could not extract text from response:', e);
        }
      } else if (response.text) {
        text = response.text;
      } else if (response.candidates && response.candidates[0] && response.candidates[0].content) {
        // Validation fallback
        const parts = response.candidates[0].content.parts || [];
        text = parts
          .filter(p => p.text)
          .map(p => p.text)
          .join(' ');
      }

      if (text) {
        if (message.source === 'http') {
          console.log('[Agent] Final Response (to console):', text);
        } else {
          const reply = createAssistantMessage(text);
          reply.metadata = { chatId: message.metadata?.chatId, model: decision.model };
          reply.source = message.source; // Ensure reply source matches incoming message source
          reply.cost = e2eCost;
          reply.tokenCount = e2eTokens;

          // 2. Save Assistant Reply
          this.db.saveMessage(reply);

          // Check if we already sent audio
          const audioTool = executionSummary.toolOutputs.find(t => t.name === 'replyWithAudio');
          const audioSent = audioTool && audioTool.result && audioTool.result.success;

          if (audioSent) {
            console.log('[Agent] Suppressing final text response because audio was sent.');
            // We saved it to DB above, but we do NOT send it to interface to avoid double notification.
          } else {
            await activeSendCallback(reply);
          }

          executionSummary.replies.push(reply);
        }
      } else {
        // If we executed tools but got no final text, assume success and generate a generic confirmation.
        if (executionSummary.toolOutputs.length > 0) {
          console.log('[Agent] No text response after tool execution. Assuming implicit success.');
          const lastTool = executionSummary.toolOutputs[executionSummary.toolOutputs.length - 1];
          // Suppress confirmation for audio responses
          if (lastTool.name === 'replyWithAudio' && lastTool.result && lastTool.result.success) {
            console.log('[Agent] Suppressing explicit confirmation for replyWithAudio.');
            // Implicit log only
            this.db.saveMessage(createAssistantMessage('Audio sent.'));
          } else {
            const reply = createAssistantMessage(`✅ Action ${lastTool.name} completed.`);
            reply.metadata = { chatId: message.metadata?.chatId };
            reply.source = message.source;

            // Save implicit reply
            this.db.saveMessage(reply);

            await activeSendCallback(reply);
            executionSummary.replies.push(reply);
          }
        } else {
          console.warn('[Agent] No text response found. Response dump:', JSON.stringify(response, null, 2));
          // Fallback notification to user
          const reply = createAssistantMessage("I received an empty response from my brain. Please try again.");
          reply.metadata = { chatId: message.metadata?.chatId };
          reply.source = message.source;
          this.db.saveMessage(reply); // Persist error so it appears in history
          await activeSendCallback(reply);
          executionSummary.replies.push(reply);
        }
      }

    } catch (error) {
      console.error('Error processing message:', error);

      const chatId = message.metadata?.chatId;
      if (chatId && message.timestamp) {
        console.warn(`[Agent] Performing Auto-Rollback for chat ${chatId} since ${message.timestamp}`);
        this.db.deleteMessagesFrom(chatId, message.timestamp);
      }

      // Build user-friendly error message
      let userMessage = error.message || 'An unexpected error occurred.';
      const errStr = error.message || '';
      if (errStr.includes('503') || errStr.includes('UNAVAILABLE') || errStr.includes('high demand') || errStr.includes('timeout') || errStr.includes('timed out')) {
        userMessage = 'The AI model is currently experiencing high demand. Please try again in a moment.';
      } else if (errStr.includes('429') || errStr.includes('RATE_LIMIT') || errStr.includes('quota')) {
        userMessage = 'Rate limit reached. Please wait a moment before sending another message.';
      } else if (errStr.includes('ContentUnion')) {
        userMessage = 'A temporary processing error occurred. Please try again.';
      }

      const errReply = createAssistantMessage(`⚠️ ${userMessage}`);
      errReply.metadata = { chatId: message.metadata?.chatId };
      errReply.source = message.source;
      try {
        await activeSendCallback(errReply);
      } catch (sendErr) {
        console.error('[Agent] Failed to send error reply to user:', sendErr.message);
      }
      executionSummary.replies.push(errReply);
    } finally {
      const isPassiveMode = message.source === 'whatsapp:user';
      if (!isPassiveMode) {
        const e2eDuration = Date.now() - e2eStart;
        this.db.logMetric('latency_e2e', e2eDuration, { chatId: message.metadata?.chatId, runId });
        // Only log cost if it exists (might be 0 for internal health checks or errors before model calls)
        if (typeof e2eCost !== 'undefined') {
          console.log(`[Agent] E2E Request Duration: ${e2eDuration}ms | Total Cost: $${e2eCost.toFixed(6)}`);
        } else {
          console.log(`[Agent] E2E Request Duration: ${e2eDuration}ms`);
        }
      }
    }

    return executionSummary;
  }






  async _executeTool(executionName, args, message, sendCallback, usageCallback = null) {
    // RESOLVE SECRETS (Variable Substitution)
    // If an argument is "$SECRET_KEY", replace it with the actual value from SkillService.
    if (this.skillService) {
      const allSecrets = this.skillService.getAllEnabledSecrets();

      const resolveSecrets = (obj) => {
        if (typeof obj === 'string' && obj.startsWith('$')) {
          const key = obj.slice(1);
          if (allSecrets[key]) {
            // console.log(`[Agent] Resolved secret variable: ${key}`);
            return allSecrets[key];
          }
        }
        if (typeof obj === 'object' && obj !== null) {
          // Handle Arrays
          if (Array.isArray(obj)) {
            return obj.map(item => resolveSecrets(item));
          }
          // Handle Objects
          const newObj = {};
          for (const k in obj) {
            newObj[k] = resolveSecrets(obj[k]);
          }
          return newObj;
        }
        return obj;
      };

      // Clone and resolve
      args = resolveSecrets(JSON.parse(JSON.stringify(args)));
    }

    // --- INTERNAL DB TOOLS ---
    if (executionName === 'rememberFact') {
      this.db.setKey(args.key, args.value, { source: 'tool', confidence: 'user_explicit' });
      return { success: true };
    }
    if (executionName === 'getFact') {
      const val = this.db.getKey(args.key);
      return val ? { value: val } : { info: 'Fact not found in database.' };
    }
    if (executionName === 'saveJobState') {
      const jobName = message.metadata?.jobName;
      if (!jobName) return { error: "This tool can only be used within a scheduled job." };

      const namespacedKey = `job:${jobName}:${args.key}`;
      this.db.setKey(namespacedKey, args.value);
      return { success: true, info: `State saved for job '${jobName}'` };
    }
    if (executionName === 'getJobState') {
      const jobName = message.metadata?.jobName;
      if (!jobName) return { error: "This tool can only be used within a scheduled job." };

      const namespacedKey = `job:${jobName}:${args.key}`;
      const val = this.db.getKey(namespacedKey);
      return val ? { value: val } : { info: 'State not found.' };
    }
    if (executionName === 'searchHistory') {
      // Use internal specific search or general DB search
      // Using existing searchMessages method
      const matches = this.db.searchMessages(args.query, args.limit || 5);
      return { matches: matches.map(m => `[${m.timestamp}] ${m.role}: ${(m.content || '').substring(0, 200)}`) };
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

    // --- SEARCH POLYFILL for STANDARD MODE ---
    if (executionName === 'googleSearch') {
      console.log('[Agent] Standard Mode: Polyfilling googleSearch via dedicated session...');
      try {
        // Create a dedicated session just for this search
        // We use a separate model instance to ensure isolation and access to native search
        const searchSession = this.client.chats.create({
          model: this.configService.getModel('SEARCH'), // Use dedicated search model
          config: {
            tools: [{ googleSearch: {} }], // Enable Native Search here
            systemInstruction: 'You are a search engine. Return the answer to the user query based on the search results. Be concise. IMPORTANT: You MUST answer in the SAME language as the user query. Do not switch languages.'
          }
        });

        let prompt = args.prompt;
        // Handle case where args might be object/string mismatch
        if (!prompt && typeof args === 'string') prompt = args;
        if (!prompt) throw new Error('No prompt provided for search.');

        const result = await searchSession.sendMessage({ message: prompt });

        // Track Usage for Polyfill
        if (result.usageMetadata && usageCallback) {
          const u = result.usageMetadata;
          usageCallback(
            this.configService.getModel('SEARCH'),
            u.promptTokenCount,
            u.candidatesTokenCount,
            u.cachedContentTokenCount || 0,
            u.thoughtsTokenCount || 0
          );
        }

        let text = '';
        if (typeof result.text === 'function') {
          try { text = result.text(); } catch (e) { /* ignore */ }
        } else if (result.text) {
          text = result.text;
        } else if (result.candidates && result.candidates[0] && result.candidates[0].content) {
          const parts = result.candidates[0].content.parts || [];
          text = parts.filter(p => p.text).map(p => p.text).join(' ');
        }

        if (!text) text = 'Search returned no text content.';
        return { result: text, info: 'Search performed via Google Grounding.' };
      } catch (e) {
        console.error('[Agent] Search Polyfill Failed:', e);
        return { error: `Search failed: ${e.message}` };
      }
    }

    // --- SUPERVISOR TOOLS ---
    if (executionName === 'rollbackLastChange') {
      const rollbackRes = await fetch(`${process.env.SUPERVISOR_URL || 'http://supervisor:4000'}/cmd/rollback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-supervisor-token': process.env.SUPERVISOR_TOKEN
        }
      });
      return await rollbackRes.json();
    }
    if (executionName === 'pullLatestChanges') {
      const pullRes = await fetch(`${process.env.SUPERVISOR_URL || 'http://supervisor:4000'}/cmd/pull`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-supervisor-token': process.env.SUPERVISOR_TOKEN
        }
      });
      return await pullRes.json();
    }
    if (executionName === 'commitAndPush') {
      const commitRes = await fetch(`${process.env.SUPERVISOR_URL || 'http://supervisor:4000'}/cmd/commit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-supervisor-token': process.env.SUPERVISOR_TOKEN
        },
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
      const result = await this.toolExecutor.execute(executionName, args, {
        message,
        sendCallback,
        processMessage: this.processMessage.bind(this),
        callServices: { client: this.client, interface: this.interface }
      });

      // Side-channel usage tracking for MCP tools (e.g. Browser Vision)
      if (result && result._meta && result._meta.usage && usageCallback) {
        const u = result._meta.usage;
        console.log(`[Agent] Tracking usage from tool '${executionName}': ${u.model} (In: ${u.inputTokens}, Out: ${u.outputTokens})`);
        usageCallback(u.model, u.inputTokens, u.outputTokens);
      }

      return result;
    } catch (error) {
      console.error(`[Agent] Tool Execution Error (${executionName}):`, error);
      throw error;
    }
  }
}

// Pricing per 1 Million Tokens (Input / Output)
// Source: https://ai.google.dev/gemini-api/docs/pricing
function calculateCost(model, inputTokens, outputTokens, cachedTokens = 0, thoughtsTokens = 0) {
  const config = new ConfigService();
  return config.calculateCost(model, inputTokens, outputTokens, cachedTokens, thoughtsTokens);
}

module.exports = { Agent };
