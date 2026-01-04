const { createAssistantMessage } = require('@deedee/shared/src/types');

class ToolExecutor {
    /**
     * @param {Object} services - The services available to the agent
     * @param {Object} services.local - LocalTools instance
     * @param {Object} services.journal - JournalManager instance
     * @param {Object} services.scheduler - Scheduler instance
     * @param {Object} services.gsuite - GSuiteTools instance
     * @param {Object} services.mcp - MCPManager instance
     * @param {Object} services.client - Gemini Client instance (for image/audio gen)
     */
    constructor(services) {
        this.services = services;
    }

    /**
     * Execute a tool by name
     * @param {string} name - Tool name
     * @param {Object} args - Tool arguments
     * @param {Object} context - Execution context
     * @param {Object} context.message - Original message object
     * @param {Function} context.sendCallback - Callback to send intermediate messages
     * @param {Function} context.processMessage - Callback to process new messages (recursion for scheduler)
     */
    async execute(name, args, context) {
        const { local, journal, scheduler, gsuite, mcp, client } = this.services;
        const { message, sendCallback, processMessage } = context;

        // --- File System ---
        if (name === 'readFile') return await local.readFile(args.path);
        if (name === 'writeFile') return await local.writeFile(args.path, args.content);
        if (name === 'listDirectory') return await local.listDirectory(args.path);
        if (name === 'runShellCommand') return await local.runShellCommand(args.command);

        // --- Memory / Search ---
        if (name === 'searchMemory') {
            const results = this.services.db.searchMessages(args.query, args.limit || 10);
            return { results };
        }

        if (name === 'consolidateMemory') {
            const date = args.date || new Date(Date.now() - 86400000).toISOString().split('T')[0]; // Default yesterday
            const messages = this.services.db.getMessagesByDate(date);

            if (!messages || messages.length === 0) {
                return { info: `No messages found for ${date}.` };
            }

            // Summarize using Gemini Flash (cheap)
            const modelName = process.env.WORKER_FLASH || 'gemini-2.0-flash-exp';
            const logText = messages.map(m => `[${m.timestamp}] ${m.role}: ${m.content}`).join('\n');
            const summaryReq = `Summarize the following chat logs from ${date} into a concise bullet-point journal entry. Focus on what was achieved, facts learned, or tasks completed. Ignore trivial chatter.\n\nLogs:\n${logText}`;

            try {
                const response = await client.models.generateContent({
                    model: modelName,
                    contents: [{ parts: [{ text: summaryReq }] }]
                });

                let summary = '';
                if (response.candidates && response.candidates[0].content && response.candidates[0].content.parts) {
                    summary = response.candidates[0].content.parts.map(p => p.text).join(' ');
                }

                if (summary) {
                    // Save to Journal
                    journal.log(`## Daily Summary (${date})\n${summary}`);
                    return { success: true, summary_preview: summary.substring(0, 100) + '...' };
                } else {
                    return { error: 'Failed to generate summary.' };
                }
            } catch (err) {
                return { error: `Consolidation failed: ${err.message}` };
            }
        }

        // --- Productivity (Journal) ---
        if (name === 'logJournal') {
            const path = journal.log(args.content);
            return { success: true, path: path };
        }

        // --- Scheduler ---
        if (name === 'scheduleJob') {
            scheduler.scheduleJob(args.name, args.cron, async () => {
                console.log(`[Scheduler] Executing task: ${args.task}`);
                const msg = createAssistantMessage(`⏰ Scheduled Task Triggered: ${args.task}`);
                msg.metadata = { chatId: 'scheduler_trigger' };

                // Use the passed processMessage callback (bound to Agent instance)
                if (processMessage) {
                    await processMessage({
                        role: 'user',
                        content: `Scheduled Task: ${args.task}`,
                        source: 'scheduler',
                        metadata: { chatId: `scheduled_${args.name}_${Date.now()}` }
                    }, async (reply) => {
                        if (this.services.interface) {
                            await this.services.interface.send(reply);
                        }
                    });
                }
            }, {
                persist: true,
                taskType: 'agent_instruction',
                payload: { task: args.task }
            });
            return { success: true, info: `Job '${args.name}' scheduled for '${args.cron}'` };
        }

        if (name === 'listJobs') {
            const jobs = Object.keys(scheduler.jobs);
            return { jobs: jobs };
        }

        if (name === 'cancelJob') {
            scheduler.cancelJob(args.name);
            return { success: true };
        }

        // --- GSuite ---
        if (name === 'google_calendar_get_events') return await gsuite.getEvents(args.timeMin, args.k);
        if (name === 'google_calendar_create_event') return await gsuite.createEvent(args);
        if (name === 'google_search_emails') return await gsuite.searchEmails(args.query, args.k);
        if (name === 'google_create_draft') return await gsuite.createDraft(args);

        // --- Native Features (Image/Audio) ---

        // Image Generation
        if (name === 'generateImage') {
            const imagenModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image-preview';
            console.log(`[ToolExecutor] Generating image with ${imagenModel} for prompt: "${args.prompt}"`);

            // 1. Generate Image
            // DO NOT CHANGE THIS CODE
            const response = await client.models.generateContent({
                model: imagenModel,
                contents: args.prompt,
                config: {
                    responseModalities: ['TEXT', 'IMAGE'],
                    tools: [{ googleSearch: {} }],
                },
            });

            // 2. Extract Image
            let b64JSON = null;
            if (response.candidates && response.candidates[0].content && response.candidates[0].content.parts) {
                // Find image part
                const parts = response.candidates[0].content.parts;
                const imagePart = parts.find(p => p.inlineData && p.inlineData.mimeType.startsWith('image/'));

                if (imagePart) {
                    b64JSON = imagePart.inlineData.data;
                }

                // Log Grounding Metadata
                if (response.candidates[0].groundingMetadata) {
                    console.log('[ToolExecutor] Grounding Metadata:', JSON.stringify(response.candidates[0].groundingMetadata, null, 2));
                } else {
                    console.log('[ToolExecutor] No Grounding Metadata found. Full Response Dump:', JSON.stringify(response, null, 2));
                }
            }

            if (!b64JSON) {
                throw new Error('No image returned from Imagen model.');
            }

            // Send Image to User!
            const imgMsg = createAssistantMessage('');
            imgMsg.parts = [{ inlineData: { mimeType: 'image/png', data: b64JSON } }];
            imgMsg.metadata = { chatId: context.message.metadata?.chatId };
            imgMsg.source = context.message.source;

            await sendCallback(imgMsg);

            return {
                success: true,
                image_base64: b64JSON,
                info: 'Image generated and sent to user.'
            };
        }

        // Reply with Audio
        if (name === 'replyWithAudio') {
            const text = args.text;
            const language = args.language || 'en-US';
            console.log(`[ToolExecutor] Generating audio for: "${text.substring(0, 30)}..." with optional lang: ${language}`);

            // 1. Generate Speech
            const modelName = process.env.GEMINI_TTS_MODEL || process.env.WORKER_FLASH || 'gemini-2.0-flash-exp';
            const audioResponse = await client.models.generateContent({
                model: modelName,
                contents: [{
                    parts: [{ text: `Please read the following text aloud in a natural, slightly fast-paced, clear voice. Return ONLY the audio data. Text: "${text}"` }]
                }],
                config: {
                    responseModalities: ['AUDIO'],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName: "Kore"
                            }
                        }
                    }
                }
            });

            // 2. Extract Audio
            let audioData = null;
            if (audioResponse.candidates && audioResponse.candidates[0].content && audioResponse.candidates[0].content.parts) {
                const part = audioResponse.candidates[0].content.parts[0];
                if (part.inlineData) {
                    audioData = part.inlineData.data;
                }
            }

            if (!audioData) {
                throw new Error('No audio returned from Gemini.');
            }

            // 3. Send to Interface
            const rawBuffer = Buffer.from(audioData, 'base64');

            // Wrap in WAV
            const wavHeader = Buffer.alloc(44);
            wavHeader.write('RIFF', 0);
            wavHeader.writeUInt32LE(36 + rawBuffer.length, 4);
            wavHeader.write('WAVE', 8);
            wavHeader.write('fmt ', 12);
            wavHeader.writeUInt32LE(16, 16);
            wavHeader.writeUInt16LE(1, 20); // PCM
            wavHeader.writeUInt16LE(1, 22); // Mono
            wavHeader.writeUInt32LE(24000, 24); // Sample Rate
            wavHeader.writeUInt32LE(24000 * 2, 28); // Byte Rate
            wavHeader.writeUInt16LE(2, 32); // Block Align
            wavHeader.writeUInt16LE(16, 34); // Bits Per Sample
            wavHeader.write('data', 36);
            wavHeader.writeUInt32LE(rawBuffer.length, 40);

            const wavBuffer = Buffer.concat([wavHeader, rawBuffer]);

            // Send!
            const audioMsg = createAssistantMessage('');
            audioMsg.parts = [{ inlineData: { mimeType: 'audio/wav', data: wavBuffer.toString('base64') } }];
            audioMsg.metadata = { chatId: context.message.metadata?.chatId };
            audioMsg.source = context.message.source;

            await sendCallback(audioMsg);

            return { success: true, info: 'Audio sent to user.' };
        }

        // --- MCP Fallback ---
        // If not matched above, try MCP
        try {
            return await mcp.callTool(name, args);
        } catch (e) {
            // If MCP fails or tool not found
            throw e; // Let the agent handle it
        }
    }
}

module.exports = { ToolExecutor };
