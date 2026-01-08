
const { createAssistantMessage } = require('@deedee/shared/src/types');
const crypto = require('crypto');
const { GSuiteTools } = require('@deedee/mcp-servers/src/gsuite/index');
const { LocalTools } = require('@deedee/mcp-servers/src/local/index');

const { AgentDB } = require('./db');
const { SmartContextManager } = require('./smart-context');
const { toolDefinitions } = require('./tools-definition');
const { Router } = require('./router');
const { MCPManager } = require('./mcp-manager');
const { CommandHandler } = require('./command-handler');
const { RateLimiter } = require('./rate-limiter');
const { ConfirmationManager } = require('./confirmation-manager');
const { ToolExecutor } = require('./tool-executor');
const path = require('path');
const { JournalManager } = require('./journal');
const VaultManager = require('./vault-manager');
const { BackupManager } = require('./backup');
const { Scheduler } = require('./scheduler');
const axios = require('axios');
const { getSystemInstruction } = require('./prompts/system');
const { getFunctionCalls, getThinkingMessage } = require('./utils/helpers');



class Agent {
  constructor(config) {
    this.interface = config.interface;
    this.config = config; // Save config for later
    this.client = null;   // Will be init in start()

    // Persistence
    this.db = new AgentDB();
    // Fallback for tests where dbPath might be undefined due to mocking
    const dataDir = this.db.dbPath ? path.dirname(this.db.dbPath) : path.join(process.cwd(), 'data');
    this.smartContext = new SmartContextManager(this.db, this.client); // Client is null here, need to set later

    // Router
    this.router = new Router(config.googleApiKey);

    // MCP Manager
    this.mcp = new MCPManager();

    // Tools Setup
    this.gsuite = new GSuiteTools();
    this.local = new LocalTools('/app/source');
    this.journal = new JournalManager();
    this.vaults = new VaultManager(dataDir); // Initialize Vaults with dynamic path
    this.backupManager = new BackupManager(this);

    this.confirmationManager = new ConfirmationManager(this.db);
    // Shared state for stopping execution
    this.stopFlags = new Set();
    this.activeTopics = new Map(); // Store active vault topics per chatId

    this.commandHandler = new CommandHandler(this.db, this.interface, this.confirmationManager, this.stopFlags);
    this.rateLimiter = new RateLimiter(this.db);

    this.scheduler = new Scheduler(this);

    // In-Memory Settings Cache
    this.settings = {};

    this.toolExecutor = new ToolExecutor({
      local: this.local,
      journal: this.journal,
      vaults: this.vaults, // Pass Vaults to Executor
      scheduler: this.scheduler,
      gsuite: this.gsuite,
      mcp: this.mcp,
      client: null, // Will be populated in processMessage
      interface: this.interface,
      db: this.db,
      agent: this
    });

    this.processMessage = this.processMessage.bind(this);
    this.onMessage = this.onMessage.bind(this);
    this.loadSettings = this.loadSettings.bind(this);
  }

  async _analyzeAttachment(chatId, part, currentVaultId) {
    console.log(`[Agent] Analyzing attachment for ${chatId}...`);
    try {
      const { mimeType, data } = part.inlineData;

      // Fetch available vaults
      const vaults = await this.vaults.listVaults();
      const vaultList = vaults.map(v => `- **${v.id}**: ${v.id === 'health' ? 'Medical records, prescriptions, workout plans, diet' : v.id === 'finance' ? 'Invoices, receipts, tax docs, bank statements' : 'Items related to ' + v.id}`).join('\n        ');

      // Construct prompt
      const prompt = `
        Analyze this document/file.
        Your goal is to determine if this file belongs to one of our specific Life Vaults:
        ${vaultList}
        
        If it belongs to one of these, you MUST output the vault ID.
        If it is generic or unclear, output "none".

        Also generate a short, descriptive title for this file/chat (max 6 words).
        Extract the likely "document date" (YYYY-MM-DD) if found, otherwise use today.

        Output JSON ONLY:
        {
            "vaultId": "Vault ID (e.g. health, finance) or 'none'",
            "title": "String",
            "date": "YYYY-MM-DD",
            "summary": "One sentence summary of content"
        }
        `;

      const schema = {
        type: "object",
        properties: {
          vaultId: { type: "string" },
          title: { type: "string" },
          date: { type: "string" },
          summary: { type: "string" }
        },
        required: ["vaultId", "title", "date", "summary"]
      };

      // We use a separate model call (Flash is fine)
      const model = process.env.WORKER_FLASH || 'gemini-2.0-flash-exp';
      const result = await this.client.models.generateContent({
        model: model,
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType, data } },
            { text: prompt }
          ]
        }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: schema
        }
      });

      const text = (result.response && typeof result.response.text === 'function') ? result.response.text() : '';
      if (!text) return;

      const analysis = JSON.parse(text);
      console.log(`[Agent] File Analysis:`, analysis);

      // ALWAYS update title if it's a new chat (heuristic)
      // Or if the current title is "New Chat"
      const session = this.db.getSession(chatId);
      if (session && (session.title === 'New Chat' || session.title === 'User sent media')) {
        this.db.updateSession(chatId, { title: analysis.title });
        // Emit update
        this.interface.emit('session:update', { id: chatId, title: analysis.title });
      }

      // Logic: Move to Vault if detected AND not already there
      if (analysis.vaultId !== 'none' && analysis.vaultId !== currentVaultId) {
        // We need to "move" the file.
        // Problem: We only have the base64 data here, user uploaded it to generic storage?
        // Actually, the frontend uploads via POST /files, THEN sends the message.
        // But the message contains the base64 data (inlineData) because we mirror it for the LLM.
        // Ideally we'd know the file path on disk.
        // Metadata should carry the path? 
        // The frontend should pass the `path` in the message metadata if it uploaded it.
        // Let's assume for now we might need to re-save it if we don't have the path, 
        // OR we fix frontend to send path in metadata.
        // Saving from base64 is reliable enough here since we have the data.

        // 1. Save to Vault
        const filename = `${analysis.title.replace(/[^a-z0-9]/gi, '_')}.${mimeType.split('/')[1]}`; // approximate ext
        // Better: use unique ID
        const safeFilename = `${Date.now()}_${analysis.title.substring(0, 20).replace(/[^a-z0-9]/gi, '_')}.${mimeType.split('/')[1]}`;

        // Write to temp, then addToVault? Or direct?
        // VaultManager.addToVault takes a source path.
        const tempPath = path.join('/tmp', safeFilename);
        await fs.promises.writeFile(tempPath, Buffer.from(data, 'base64'));

        // Add to Vault
        await this.vaults.addToVault(analysis.vaultId, tempPath, safeFilename);

        // Cleanup temp
        await fs.promises.unlink(tempPath);

        // 2. Update Vault Wiki
        const wikiEntry = `\n\n## Added on ${analysis.date}\n- **File**: ${safeFilename}\n- **Title**: ${analysis.title}\n- **Summary**: ${analysis.summary}`;
        const currentWiki = await this.vaults.readVaultPage(analysis.vaultId, 'index.md') || `# ${analysis.vaultId} Vault`;
        await this.vaults.updateVaultPage(analysis.vaultId, 'index.md', currentWiki + wikiEntry);

        // 3. Switch Context
        this.activeTopics.set(chatId, analysis.vaultId);

        // 4. Notify User
        const notification = createAssistantMessage(`📂 I've detected this is a **${analysis.vaultId}** document.\n\nI've filed it in your **${analysis.vaultId}** vault and updated the context.`);
        notification.metadata = { chatId, vaultId: analysis.vaultId }; // Update frontend state
        await this.interface.send(notification);
      }

    } catch (e) {
      console.error('[Agent] Attachment analysis failed:', e);
    }
  }

  async loadSettings() {
    try {
      const stmt = this.db.db.prepare('SELECT key, value FROM agent_settings');
      const rows = stmt.all();

      this.settings = rows.reduce((acc, row) => {
        try {
          acc[row.key] = JSON.parse(row.value);
        } catch (e) {
          acc[row.key] = row.value;
        }
        return acc;
      }, {});
      console.log(`[Agent] Loaded ${Object.keys(this.settings).length} settings from DB.`);
    } catch (err) {
      console.error('[Agent] Failed to load settings:', err);
    }
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

    // Load Runtime Settings
    await this.loadSettings();

    // Load Scheduled Jobs
    await this.scheduler.loadJobs();

    // Initialize Vaults
    await this.vaults.initialize();

    // Ensure System Maintenance Jobs
    this.scheduler.ensureSystemJobs();

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
   * Helper to send message efficiently with streaming and token broadcasting
   */
  async _generateStream(session, payload, chatId, source) {
    try {
      let result;
      if (source === 'web') {
        result = await session.sendMessageStream(payload);
      } else {
        result = await session.sendMessage(payload);
      }

      // Detect if result itself is the stream (Async Generator)
      let stream = result.stream || result;
      if (!stream[Symbol.asyncIterator] && result.stream) {
        stream = result.stream;
      }

      // Handle streaming
      if (source === 'web' && stream && typeof stream[Symbol.asyncIterator] === 'function') {
        for await (const chunk of stream) {
          const text = chunk.text;
          if (text) {
            this.interface.emit('chat:token', {
              id: chatId,
              token: text,
              timestamp: Date.now()
            });
          }
        }
      } else {
        // Non-streaming or no stream returned
      }

      // Get final response
      let response = result.response;
      if (response && typeof response.then === 'function') {
        response = await response;
      }

      // Fallback: If result matches standard structure
      if (!response && result.candidates) {
        response = result;
      }

      if (!response) {
        console.warn('[Agent] Stream result.response is undefined. Trying to recover...');
        console.log('[Agent] Raw Result Keys:', Object.keys(result));
      }
      return response;
    } catch (e) {
      console.error(`[Agent] sendMessageStream failed: ${e.message}`);
      // Fallback to non-streaming if streaming specifically fails
      try {
        console.warn('[Agent] Falling back to non-streaming sendMessage...');
        const result = await session.sendMessage(payload);
        // Sometimes the SDK returns the response directly (impl-dependent)
        const response = result.response || (result.candidates ? result : undefined);

        if (!response) {
          console.warn('[Agent] Fallback response is undefined. Raw result:', JSON.stringify(result, null, 2));
        }
        return response;
      } catch (innerE) {
        throw innerE;
      }
    }
  }

  /**
   * Core processing logic.
   * @param {object} message - Incoming message
   * @param {function} sendCallback - Async function(reply) to handle responses
   * @param {function} onProgress - Optional async function(status) to report progress
   */
  async processMessage(message, sendCallback, onProgress = async () => { }) {
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

      // Propagate dependencies to ToolExecutor
      this.toolExecutor.services.client = this.client;
      this.toolExecutor.services.interface = this.interface;
      this.smartContext.client = this.client; // Ensure client is available for summarization

      const chatId = message.metadata?.chatId;

      // Ensure Session Exists (Multi-Threaded Chat Support)
      if (chatId) {
        const msgCount = this.db.countMessages(chatId);
        this.db.ensureSession(chatId, message.source);

        // Log Location on New Session
        // DEBUG: Log all metadata to see what's happening
        // console.log(`[Agent] Metadata for ${chatId}:`, JSON.stringify(message.metadata));

        if (msgCount === 0) {
          if (message.metadata?.location) {
            console.log(`[Agent] New Session ${chatId} started from location: ${message.metadata.location}`);
          } else {
            console.log(`[Agent] New Session ${chatId} started. (No location data in metadata)`);
          }
        }

        // Handle Vault Context Switch
        if (message.metadata?.vaultId) {
          if (message.metadata.vaultId === 'none') {
            this.activeTopics.delete(chatId);
            console.log(`[Agent] Chat ${chatId} exited vault context.`);
          } else {
            this.activeTopics.set(chatId, message.metadata.vaultId);
            console.log(`[Agent] Chat ${chatId} switched to vault context: ${message.metadata.vaultId}`);
          }
        }

        // Auto-Title Trigger (Background)
        const hasContent = message.content || (message.parts && message.parts.length > 0);

        if (msgCount === 0 && hasContent && message.role === 'user') {
          console.log(`[Agent] Triggering Auto-Title for ${chatId}. MsgCount: ${msgCount}`);

          let titleContext = message.content;
          if (!titleContext && message.parts) {
            const textPart = message.parts.find(p => p.text);
            titleContext = textPart ? textPart.text : "User sent media";
          }

          // Don't await - run in background
          this._autoTitleSession(chatId, titleContext).catch(err => {
            console.error(`[Agent] Auto-Title CRASHED for ${chatId}:`, err);
          });
        } else {
          if (msgCount === 0) console.log(`[Agent] Skipped Auto-Title. HasContent: ${!!hasContent}, Role: ${message.role}`);
        }

        // --- SMART FILE ANALYSIS ---
        // Trigger if:
        // 1. User message contains a file (or attachment)
        // 2. We are in a generic context (vaultId is 'none' or undefined)
        // 3. It's a relatively new session (msgCount < 5) to avoid re-analyzing old stuff? Or always?
        // Let's do it for any NEW user message that has attachments.

        // We need to detect "attachments". The frontend sends them as `parts` with inlineData or fileData.
        // OR as separate messages. The frontend logic sends mixed content now.
        // Let's look for parts with mimeType that are NOT audio/image (or usually documents).
        // Actually PDF is application/pdf.

        if (message.parts && message.role === 'user') {
          const attachment = message.parts.find(p => p.inlineData && !p.inlineData.mimeType.startsWith('audio/') && !p.inlineData.mimeType.startsWith('image/'));
          // Or maybe we treat images as potentially vault-worthy too (receipts, medical scans)?
          // Let's broaden to "any non-audio" for now, or specific PDF focus?
          // User mentioned "PDFs to act on them... blood.pdf". 
          // Let's classify anything that looks substantive. PDF, Text, Images.
          // Exclude Audio (Voice Notes).

          const candidatePart = message.parts.find(p =>
            p.inlineData && !p.inlineData.mimeType.startsWith('audio/')
          );

          if (candidatePart) {
            // Run in background to not block chat latency
            this._analyzeAttachment(chatId, candidatePart, message.metadata?.vaultId || 'none').catch(console.error);
          }
        }
      }

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
        const result = await this._executeTool(action.name, action.args, message, sendCallback, (model, pTokens, cTokens) => {
          const cost = calculateCost(model, pTokens, cTokens);
          // We don't have e2eCost/Tokens variables in this scope easily for the command handler return path
          // But we can at least log it to DB
          this.db.logTokenUsage({
            model, promptTokens: pTokens, candidateTokens: cTokens,
            totalTokens: pTokens + cTokens, chatId, estimatedCost: cost
          });
        });

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

      await reportProgress('Routing...');

      // --- ROUTING ---
      let e2eCost = 0; // Track total cost for this request
      let e2eTokens = 0; // Track total tokens
      console.time('[Agent] Router Duration');
      const routerStart = Date.now();

      // Get brief history for context (last 3 messages)
      const routingHistory = this.db.getHistoryForChat(chatId, 3);

      // Pass the primary content or parts to router
      const decision = await this.router.route(message.parts || message.content, routingHistory);
      const routerDuration = Date.now() - routerStart;
      console.timeEnd('[Agent] Router Duration');

      this.db.logMetric('latency_router', routerDuration, { model: decision.model, chatId, runId });

      console.log(`[Agent] Routing to: ${decision.model}`);

      // --- BYPASS: DIRECT IMAGE GENERATION ---
      if (decision.model === 'IMAGE') {
        console.log('[Agent] Executing Direct Image Generation Bypass');

        let prompt = message.content;
        // Handle multimodal prompt extraction if needed, but usually image gen prompt is text
        if (message.parts) {
          prompt = message.parts.map(p => p.text).join(' ');
        }

        const toolResult = await this._executeTool('generateImage', { prompt: prompt }, message, sendCallback, (model, pTokens, cTokens) => {
          // Image gen usually flat cost or different metric, but if we had tokens we'd track here.
          // For now, no-op or specific image cost logic if needed.
        });
        executionSummary.toolOutputs.push({ name: 'generateImage', result: toolResult });

        // Optionally send a text confirmation
        const reply = createAssistantMessage('Image generated.');
        reply.metadata = { chatId: message.metadata?.chatId };
        reply.source = message.source;
        await sendCallback(reply);
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
        ? (process.env.WORKER_FLASH || 'gemini-2.0-flash-exp')
        : (process.env.WORKER_PRO || 'gemini-3-pro-preview');

      console.log(`[Agent] Routing to Model: ${selectedModel}`);
      await reportProgress(`Thinking (${selectedModel})...`);

      // --- EXPERIMENTAL: Adaptive Context Window ---
      // Flash models (simple tasks) need less context. Pro models (reasoning) need more.


      // --- HYDRATION ---
      const historyLimit = (decision.model === 'FLASH' || decision.model === 'IMAGE') ? 10 : 50;
      console.log(`[Agent] Fetching history (Smart Context) for model: ${decision.model}`);

      // --- HYDRATION (Smart Context) ---
      const history = await this.smartContext.getContext(chatId, decision.model);

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

      // Load Configuration
      const searchConfig = this.db.getKey('config:search_strategy') || { mode: 'HYBRID' };
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
        geminiTools = [{ googleSearch: {} }];
      } else {
        // Standard Function Calling (includes 'googleSearch' polyfill if needed)
        console.log(`[Agent] Mode: STANDARD (Function Calling) - Enforced for ${decision.toolMode}`);
        geminiTools = [{ functionDeclarations: allTools }];
      }

      // Build System Instruction
      const pendingGoals = this.db.getPendingGoals()
        .map(g => `- [${g.id}] ${g.description}`)
        .join('\n            ');

      // Fetch Memory/Facts
      const facts = this.db.getAllFacts()
        .map(f => `- **${f.key}**: ${JSON.stringify(f.value)}`)
        .join('\n            ');

      // Enable Coding/Dev Instructions ONLY for Pro/Reasoning models
      const isCodingMode = decision.model === 'PRO';

      let systemInstruction = getSystemInstruction(new Date().toString(), pendingGoals, facts, { codingMode: isCodingMode });

      // --- LIFE VAULTS CONTEXT INJECTION ---
      const activeTopic = this.activeTopics.get(chatId);
      if (activeTopic) {
        try {
          // Read Wiki
          const wikiContent = await this.vaults.readVaultPage(activeTopic, 'index.md');
          // List Files
          const files = await this.vaults.listVaultFiles(activeTopic);

          if (wikiContent) {
            console.log(`[Agent] Injecting Vault Context: ${activeTopic}`);
            systemInstruction += `\n
\n=== 📂 ACTIVE VAULT: ${activeTopic.toUpperCase()} ===
You are now accessing the user's ${activeTopic} knowledge base.

## SUMMARY (from index.md):
${wikiContent}

## AVAILABLE FILES:
${files.length > 0 ? files.join(", ") : "No files yet."}

## INSTRUCTIONS:
- Use this context to answer questions.
- If you need to see a specific file's details, use 'readVaultFile'.
- If you receive new information, use 'updateVaultPage' to keep the index fresh.
================================
`;
          }
        } catch (err) {
          console.error(`[Agent] Failed to inject vault context for ${activeTopic}:`, err);
        }
      }

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
          response = await this._generateStream(session, { message: message.parts || message.content }, chatId, message.source);

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

          console.warn(`[Agent] Empty response detected (FinishReason: ${firstCandidate?.finishReason}). Retrying...`);
        } catch (e) {
          console.warn(`[Agent] Model request failed: ${e.message}. Retrying...`);
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
        const { promptTokenCount, candidatesTokenCount, totalTokenCount } = response.usageMetadata;
        const cost = calculateCost(selectedModel, promptTokenCount, candidatesTokenCount);
        e2eCost += cost;
        e2eTokens += totalTokenCount;

        console.log(`[Tokens] P: ${promptTokenCount} | C: ${candidatesTokenCount} | Total: ${totalTokenCount} | Cost: $${cost.toFixed(6)}`);

        this.db.logTokenUsage({
          model: selectedModel,
          promptTokens: promptTokenCount,
          candidateTokens: candidatesTokenCount,
          totalTokens: totalTokenCount,
          chatId,
          estimatedCost: cost
        });
      }

      // 3. Handle Function Calls Loop
      let functionCalls = getFunctionCalls(response);


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
          const thinkText = getThinkingMessage(functionCalls);
          if (thinkText) {
            const updateMsg = createAssistantMessage(`Still working... (${thinkText})`);
            updateMsg.metadata = { chatId: message.metadata?.chatId };
            updateMsg.source = message.source;
            await sendCallback(updateMsg).catch(err => console.error('[Agent] Failed to send update msg:', err));
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
        console.log(`[Agent] Processing ${functionCalls.length} tool calls in parallel.`);
        const toolNames = functionCalls.map(c => (c.name || '').replace('default_api:', '')).join(', ');
        await reportProgress(`Executing ${functionCalls.length} tools: ${toolNames}...`);

        // 1. Start Global Thinking Timer (for the batch)
        let thinkTimer = setTimeout(async () => {
          const thinkText = getThinkingMessage(functionCalls);
          if (thinkText) {
            const thinkingMsg = createAssistantMessage(`Thinking... (${thinkText})`);
            thinkingMsg.metadata = { chatId: message.metadata?.chatId };
            thinkingMsg.source = message.source;
            await sendCallback(thinkingMsg).catch(err => console.error('[Agent] Failed to send thinking msg:', err));
          }
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
              toolResult = await this._executeTool(executionName, call.args, message, sendCallback, (model, pTokens, cTokens) => {
                const cost = calculateCost(model, pTokens, cTokens);
                e2eCost += cost;
                e2eTokens += (pTokens + cTokens);
                console.log(`[Tokens-Polyfill] P: ${pTokens} | C: ${cTokens} | Cost: $${cost.toFixed(6)}`);

                this.db.logTokenUsage({
                  model, promptTokens: pTokens, candidateTokens: cTokens,
                  totalTokens: pTokens + cTokens, chatId, estimatedCost: cost
                });
              });
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
          console.log(`Tool Result (${executionName}):`, logResult);

          // Sanitize for DB AND Model to prevent Context Pollution
          let dbToolResult = result;
          if (executionName === 'generateImage') {
            // Gemini does NOT need the base64. It just needs success.
            dbToolResult = { info: 'Image generated and sent to user.' };
          } else if (result && result.image_base64 && result.image_base64.length > 500) {
            dbToolResult = { ...result, image_base64: '<BASE64_IMAGE_TRUNCATED>' };
          }

          // Build API Payload (Send CLEAN result to Model)
          // SDK Requirement: 'response' must be an object map.
          let apiResponse = dbToolResult;
          if (typeof dbToolResult !== 'object' || dbToolResult === null || Array.isArray(dbToolResult)) {
            apiResponse = { result: dbToolResult };
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
          // FIX: Pass parts directly for correct ContentUnion matching in SDK
          const payload = functionResponseParts;
          let result;

          if (message.source === 'web') {
            result = await session.sendMessageStream(payload);
          } else {
            result = await session.sendMessage(payload);
          }

          // Detect if result itself is the stream (Async Generator)
          let stream = result.stream || result;
          if (!stream[Symbol.asyncIterator] && result.stream) {
            stream = result.stream;
          }

          // Handle streaming
          const finalResponsePromise = (async () => {
            // Iterate to drain stream and trigger tokens
            if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
              for await (const chunk of stream) {
                // FIX: chunk.text might not be a function in some SDK versions or response types
                let text;
                if (typeof chunk.text === 'function') {
                  text = chunk.text();
                } else {
                  text = chunk.text;
                }

                if (text) this.interface.emit('chat:token', { id: chatId, token: text, timestamp: Date.now() });
              }
            }

            // Await final response
            let resp = result.response;
            if (resp && typeof resp.then === 'function') resp = await resp;
            if (!resp && result.candidates) resp = result;
            return resp;
          })();

          response = await finalResponsePromise;

        } catch (e) {
          console.error('[Agent] Tool response streaming failed:', e);
          // DEBUG: Log the raw payload to help diagnose SDK validation errors
          console.log('[Agent] FAILING PAYLOAD (functionResponseParts):', JSON.stringify(functionResponseParts, null, 2));
          throw e;
        }

        console.timeEnd(toolTimerLabel);

        // USAGE LOGGING (Tool Loop)
        if (response.usageMetadata) {
          const { promptTokenCount, candidatesTokenCount, totalTokenCount } = response.usageMetadata;
          const cost = calculateCost(selectedModel, promptTokenCount, candidatesTokenCount);
          e2eCost += cost;
          e2eTokens += totalTokenCount;

          console.log(`[Tokens-Tool] P: ${promptTokenCount} | C: ${candidatesTokenCount} | Total: ${totalTokenCount} | Cost: $${cost.toFixed(6)}`);

          this.db.logTokenUsage({
            model: selectedModel,
            promptTokens: promptTokenCount,
            candidateTokens: candidatesTokenCount,
            totalTokens: totalTokenCount,
            chatId,
            estimatedCost: cost
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
        } catch (e) {
          // Sometimes text() throws if candidate safety blocked
          console.warn('[Agent] response.text() threw:', e.message);
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
          reply.metadata = { chatId: message.metadata?.chatId };
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
            await sendCallback(reply);
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

            await sendCallback(reply);
            executionSummary.replies.push(reply);
          }
        } else {
          console.warn('[Agent] No text response found. Response dump:', JSON.stringify(response, null, 2));
          // Fallback notification to user
          const reply = createAssistantMessage("I received an empty response from my brain. Please try again.");
          reply.metadata = { chatId: message.metadata?.chatId };
          reply.source = message.source;
          this.db.saveMessage(reply); // Persist error so it appears in history
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
      try {
        await sendCallback(errReply);
      } catch (sendErr) {
        console.error('[Agent] Failed to send error reply to user:', sendErr.message);
      }
      executionSummary.replies.push(errReply);
    } finally {
      const e2eDuration = Date.now() - e2eStart;
      this.db.logMetric('latency_e2e', e2eDuration, { chatId: message.metadata?.chatId, runId });
      // Only log cost if it exists (might be 0 for internal health checks or errors before model calls)
      if (typeof e2eCost !== 'undefined') {
        console.log(`[Agent] E2E Request Duration: ${e2eDuration}ms | Total Cost: $${e2eCost.toFixed(6)}`);
      } else {
        console.log(`[Agent] E2E Request Duration: ${e2eDuration}ms`);
      }
    }

    return executionSummary;
  }



  async _autoTitleSession(chatId, firstMessageContent) {
    try {
      console.log(`[Agent] Auto-titling session ${chatId}...`);
      // Use Flash for speed/cost
      const model = process.env.WORKER_FLASH || 'gemini-2.0-flash-exp';
      const prompt = `
        Generate a short, concise title (3-5 words max) for a chat session that starts with this user message:
        "${firstMessageContent}"
        
        Do not use quotes. Just the title.
      `;

      const schema = {
        type: "object",
        properties: {
          title: { type: "string" }
        },
        required: ["title"]
      };

      // Use a separate stateless call
      const { GoogleGenAI } = await this._loadClientLibrary();
      const client = new GoogleGenAI({ apiKey: this.config.googleApiKey });

      const response = await client.models.generateContent({
        model: model,
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }]
          }
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: schema,
          temperature: 0.5
        }
      });

      let title = '';
      const text = (response && response.text) ? (typeof response.text === 'function' ? response.text() : response.text) : '';

      if (text) {
        try {
          const json = JSON.parse(text);
          title = json.title;
        } catch (e) {
          console.warn('[Agent] Failed to parse title JSON:', e);
        }
      }

      title = title ? title.trim() : '';

      if (title) {
        this.db.updateSession(chatId, { title });
        console.log(`[Agent] Session ${chatId} titled: "${title}"`);

        // Notify client to update UI
        await this.interface.send({
          source: 'web',
          type: 'session_update',
          content: JSON.stringify({ id: chatId, title }),
          metadata: { chatId }
        });
      }
    } catch (err) {
      console.error('[Agent] Auto-titling failed:', err.message);
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

  async _executeTool(executionName, args, message, sendCallback, usageCallback = null) {
    // --- INTERNAL DB TOOLS ---
    if (executionName === 'rememberFact') {
      this.db.setKey(args.key, args.value);
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
      return { matches: matches.map(m => `[${m.timestamp}] ${m.role}: ${m.content.substring(0, 200)}`) };
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
          model: process.env.WORKER_FLASH || 'gemini-2.0-flash-exp', // Use Flash for speed
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
            process.env.WORKER_FLASH || 'gemini-2.0-flash-exp',
            u.promptTokenCount,
            u.candidatesTokenCount
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

// Pricing per 1 Million Tokens (Input / Output)
// Source: https://ai.google.dev/gemini-api/docs/pricing
const PRICING = {
  // Direct Model Definitions
  'gemini-2.5-flash': {
    threshold: 128000,
    tier1: { input: 0.30, output: 0.60 }, // <= 128k
    tier2: { input: 1.0, output: 2.5 }  // > 128k (Est: 2x)
  },
  'gemini-2.0-flash-exp': {
    threshold: 128000,
    tier1: { input: 0.15, output: 0.60 },
    tier2: { input: 0.30, output: 1.20 }
  },
  'gemini-3-pro-preview': {
    threshold: 200000, // Pro Preview usually has 200k tier
    tier1: { input: 2.00, output: 12.00 }, // <= 200k
    tier2: { input: 4.00, output: 18.00 }  // > 200k
  },
  'gemini-2.5-pro': {
    threshold: 200000,
    tier1: { input: 2.00, output: 12.00 },
    tier2: { input: 4.00, output: 18.00 }
  },
  // TTS & Image Models
  'gemini-2.5-flash-preview-tts': {
    threshold: 128000,
    tier1: { input: 0.50, output: 10 },
    tier2: { input: 0.50, output: 10 }
  },
  'gemini-3-pro-image-preview': {
    threshold: 200000,
    tier1: { input: 2.00, output: 120.00 },
    tier2: { input: 2.00, output: 120.00 }
  },

  // Default/Fallback keys
  'FLASH_DEFAULT': {
    threshold: 128000,
    tier1: { input: 0.15, output: 0.60 },
    tier2: { input: 0.30, output: 1.20 }
  },
  'PRO_DEFAULT': {
    threshold: 200000,
    tier1: { input: 2.00, output: 12.00 },
    tier2: { input: 4.00, output: 18.00 }
  }
};

function calculateCost(model, inputTokens, outputTokens) {
  let pricing = null;

  if (PRICING[model]) {
    pricing = PRICING[model];
  } else {
    const lower = model.toLowerCase();
    if (lower.includes('pro')) pricing = PRICING['PRO_DEFAULT'];
    else pricing = PRICING['FLASH_DEFAULT'];

    console.warn(`[Cost] Model "${model}" not found in PRICING table. Falling back to default (${lower.includes('pro') ? 'PRO' : 'FLASH'}).`);
  }

  // Determine tier based on input tokens and specific model threshold
  const limit = pricing.threshold || 128000;
  const tier = inputTokens <= limit ? pricing.tier1 : pricing.tier2;

  const inputCost = (inputTokens / 1_000_000) * tier.input;
  const outputCost = (outputTokens / 1_000_000) * tier.output;

  return inputCost + outputCost;
}

module.exports = { Agent };
