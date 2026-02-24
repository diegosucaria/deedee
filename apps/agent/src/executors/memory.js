const { BaseExecutor } = require('./base');
const { getConsolidationPrompt } = require('../prompts/memory');

class MemoryExecutor extends BaseExecutor {
    async execute(name, args, context) {
        const { db, client } = this.services;
        const { message } = context;

        switch (name) {
            case 'searchMemory': {
                const results = db.searchMessages(args.query, args.limit || 10);
                return { results };
            }

            case 'consolidateMemory': {
                // Use Local Time for "Yesterday" calculation
                let date = args.date;
                if (!date) {
                    const yesterday = new Date(Date.now() - 86400000); // 24h ago

                    // Force rigorous timezone parsing to avoid Docker TZ drift or boundary issues
                    const formatter = new Intl.DateTimeFormat('en-CA', {
                        timeZone: process.env.TZ || 'America/Argentina/Buenos_Aires',
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit'
                    });

                    date = formatter.format(yesterday);
                }

                console.log(`[Consolidation] Target date: ${date} | TZ: ${process.env.TZ} | Now (UTC): ${new Date().toISOString()}`);

                const messages = db.getMessagesByDate(date);

                // Diagnostic: count messages by source
                const sourceCounts = {};
                (messages || []).forEach(m => {
                    const src = m.source || 'agent';
                    sourceCounts[src] = (sourceCounts[src] || 0) + 1;
                });
                console.log(`[Consolidation] Messages found: ${messages?.length || 0} | By source: ${JSON.stringify(sourceCounts)}`);

                if (!messages || messages.length === 0) {
                    return { info: `No messages found for ${date}.` };
                }

                // Summarize using Gemini Pro for advanced reasoning
                const { agent } = this.services;
                const modelName = agent.configService.getModel('PRO');
                // Cache for contact names to avoid repeated DB lookups
                const contactCache = new Map();

                // Helper: extract phone number from metadata
                const resolvePhone = (meta) => {
                    // Agent DB messages use phoneNumber or contactId
                    if (meta.phoneNumber || meta.contactId) return meta.phoneNumber || meta.contactId;
                    // WhatsApp messages use chatId (e.g. 5491130579025@s.whatsapp.net)
                    if (meta.chatId) return meta.chatId.replace(/@.*$/, '');
                    return null;
                };

                // Helper: resolve a phone to a display name
                const resolveName = (phone) => {
                    if (!phone) return null;
                    if (!contactCache.has(phone)) {
                        const person = db.getPerson(phone);
                        contactCache.set(phone, person?.name ? person.name : phone);
                    }
                    return contactCache.get(phone);
                };

                // Group messages by conversation (chatId or session)
                const chatGroups = new Map(); // chatKey -> [messages]
                for (const m of messages) {
                    let chatKey = 'agent'; // default for agent DB messages
                    let sender = m.role;

                    if (m.metadata) {
                        try {
                            const meta = JSON.parse(m.metadata);
                            const phone = resolvePhone(meta);
                            if (phone) {
                                chatKey = phone;
                                if (m.role === 'user') {
                                    sender = resolveName(phone) || phone;
                                }
                            }
                        } catch (e) { /* ignore */ }
                    }

                    if (m.role === 'model' || m.role === 'assistant') {
                        sender = 'Diego (via Agent)';
                    }

                    if (!chatGroups.has(chatKey)) chatGroups.set(chatKey, []);
                    chatGroups.get(chatKey).push(`[${m.timestamp}] ${sender}: ${m.content}`);
                }

                // Build logText with chat headers for clarity
                const logSections = [];
                for (const [chatKey, lines] of chatGroups) {
                    const contactName = resolveName(chatKey);
                    const header = chatKey === 'agent'
                        ? '--- System / Agent Messages ---'
                        : `--- Conversation with ${contactName || chatKey} ---`;
                    logSections.push(`${header}\n${lines.join('\n')}`);
                }
                const logText = logSections.join('\n\n');

                const summaryReq = getConsolidationPrompt(date, logText);

                // Diagnostic: preview of what the LLM will see
                const previewLines = logText.split('\n').slice(0, 5);
                console.log(`[Consolidation] LogText preview (first 5 lines):\n${previewLines.join('\n')}`);
                console.log(`[Consolidation] Total logText length: ${logText.length} chars`);

                try {
                    const response = await client.models.generateContent({
                        model: modelName,
                        contents: [{ parts: [{ text: summaryReq }] }],
                        generationConfig: { responseMimeType: 'application/json' }
                    });

                    let data = null;
                    try {
                        const raw = response.candidates[0].content.parts.map(p => p.text).join(' ');
                        data = JSON.parse(raw);
                    } catch (e) {
                        // Fallback JSON extraction
                        // Sometimes model wraps in markdown code block
                        const raw = response.candidates[0].content.parts.map(p => p.text).join(' ');
                        const match = raw.match(/```json\n([\s\S]*?)\n```/) || raw.match(/{[\s\S]*}/);
                        if (match) data = JSON.parse(match[1] || match[0]);
                    }

                    if (data && data.summary) {
                        // 1. Log Journal
                        this.services.journal.log(`## Daily Summary (${date})\n${data.summary}`);

                        // 2. Save Facts to DB
                        let factsAdded = 0;
                        if (data.facts && Array.isArray(data.facts)) {
                            for (const f of data.facts) {
                                if (f.key && f.value) {
                                    db.setKey(f.key, f.value);
                                    factsAdded++;
                                }
                            }
                        }

                        // 3. Sync & Ingest
                        if (factsAdded > 0) {
                            const allFacts = db.getAllFacts();
                            const memoryPath = await this.services.journal.syncFactsToMemory(allFacts);
                            await agent.ragService.ingestDocument(memoryPath, 'memory');
                        }

                        const summaryStr = typeof data.summary === 'string' ? data.summary : String(data.summary);
                        return {
                            success: true,
                            summary_preview: summaryStr.substring(0, 100) + '...',
                            facts_learned: factsAdded
                        };
                    } else {
                        return { error: 'Failed to generate valid summary JSON.' };
                    }
                } catch (err) {
                    return { error: `Consolidation failed: ${err.message}` };
                }
            }

            default: return null;
        }
    }
}

module.exports = { MemoryExecutor };
